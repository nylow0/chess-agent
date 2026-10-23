import { expect, test } from "bun:test";
import { FEATURE_NAMES, type Decision, type GameAnalysis, type GameDetail, type GameSummary, type MoveAnalysis, type MoveFeatures, type ProfileStats, type StyleCandidate, type StyleProfile } from "@chess/shared";
import app from "./routes";
import { db, SUMMARY_VERSION } from "./db";
import { ANALYSIS_REVISION, analyzeGame, analyzePosition, buildDecisions, classify, computeSummary, migrateSummaries, pump, queueAnalysis, repairAnalysis, resolveWorkerCount, setTrainingScheduler } from "./worker";
import { makeTrainSpawner, profileSignature, readStyleProfile, recommend, saveProfile, trainProfile } from "./style";
import { engineMeta, type Engine } from "./engine";
import { purgeStaleEvaluations, requeueOutdatedAnalyses } from "./reanalyze";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

const zero = Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, 0])) as MoveFeatures;
const ones = Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, 1])) as MoveFeatures;

function candidate(uci: string, value: number, trades: number): StyleCandidate {
  return { uci, san: uci, cp: value, mate: null, pv: [uci], value, features: { ...zero, trades } };
}

function minimalAnalysis(uuid: string): GameAnalysis {
  return {
    gameUuid: uuid,
    engine: { name: "x", version: "y", depth: 1, multiPv: 6 },
    moves: [{
      ply: 1, san: "e4", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "e2e4",
      cpBefore: 20, cpAfter: 20, mateBefore: null, mateAfter: null, cpl: 0, classification: "best",
      lines: [{ uci: "e2e4", san: "e4", cp: 20, mate: null, pv: ["e2e4"] }],
    }],
    summary: { myAccuracy: 0, myCpl: 0, opponentAccuracy: 0, counts: { best: 1, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0 } },
  };
}

function insertGame(
  uuid: string,
  fields: Partial<{
    white_username: string;
    black_username: string;
    white_result: string;
    black_result: string;
    end_time: number;
    url: string;
    opening: string;
  }>
): void {
  db.run(
    `INSERT INTO games (uuid, pgn, url, time_control, time_class, rated, end_time,
       white_username, white_rating, white_result, black_username, black_rating, black_result, opening)
     VALUES (?, '1. e4 e5', ?, '600', 'blitz', 1, ?, ?, 1500, ?, ?, 1500, ?, ?)`,
    [
      uuid,
      fields.url ?? null,
      fields.end_time ?? 0,
      fields.white_username ?? "white",
      fields.white_result ?? "win",
      fields.black_username ?? "black",
      fields.black_result ?? "loss",
      fields.opening ?? null,
    ]
  );
}

function insertAnalysis(
  uuid: string,
  username: string,
  status: string,
  data: string | null,
  extra: {
    my_accuracy?: number;
    my_cpl?: number;
    my_counts?: string;
    summary_version?: number;
    updated_at?: number;
  } = {}
): void {
  db.run(
    `INSERT INTO analyses (game_uuid, username, status, data, my_accuracy, my_cpl, my_counts, summary_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      username,
      status,
      data,
      extra.my_accuracy ?? null,
      extra.my_cpl ?? null,
      extra.my_counts ?? null,
      extra.summary_version ?? 0,
      extra.updated_at ?? 0,
    ]
  );
}

test("analysis worker count defaults to a quarter of the cores and clamps", () => {
  expect(resolveWorkerCount(undefined, 16)).toBe(4);
  expect(resolveWorkerCount(undefined, 8)).toBe(2);
  expect(resolveWorkerCount(undefined, 2)).toBe(1);
  expect(resolveWorkerCount("3", 16)).toBe(3);
  expect(resolveWorkerCount("9", 16)).toBe(4);
  expect(resolveWorkerCount("abc", 8)).toBe(2);
  // Fractions are floored to whole worker processes.
  expect(resolveWorkerCount("2.5", 16)).toBe(2);
  expect(resolveWorkerCount("3.9", 16)).toBe(3);
  expect(resolveWorkerCount("0.5", 16)).toBe(1);
});

test("classification follows win-probability loss, not raw centipawns", () => {
  // Losing 3 pawns while nine ahead changes almost nothing.
  expect(classify(300, false, 900)).toBe("inaccuracy");
  expect(classify(300, false, 900)).not.toBe("blunder");
  // The same loss from a balanced position is a blunder.
  expect(classify(300, false, 0)).toBe("blunder");
  // The engine's first line is always best, and a null cpl means no loss.
  expect(classify(300, true, 900)).toBe("best");
  expect(classify(null, false, 0)).toBe("best");
});

test("game accuracy matches the fitted position curve, rescale and capped length adjustment", () => {
  const analysis = minimalAnalysis("fitted-accuracy");
  const template = analysis.moves[0];
  const evaluations: Partial<MoveAnalysis>[] = [
    { cpBefore: null, cpl: null },
    { cpBefore: 100, cpAfter: 120, cpl: 20 },
    { cpBefore: 4500, cpAfter: -4500, cpl: 2000 },
    { cpBefore: null, mateBefore: -3, cpl: null },
    { cpBefore: -100, cpAfter: -150, cpl: 50 },
    { cpBefore: null, cpl: null },
    { cpBefore: 100, cpAfter: 100, cpl: 0 },
    { cpBefore: 100, cpAfter: null, cpl: 0 },
  ];
  analysis.moves = evaluations.map((evaluation, i) => ({
    ...template, ply: i + 1, fenBefore: i % 2 === 0 ? START_FEN : AFTER_E4, ...evaluation,
  }));

  // White move scores are 0 after clamping +/-4500 to +/-3000, 89.517632385180, and 100.
  // 2.332013 * their mean - 135.485518 + 4*ln(3) = 16.228125305159.
  // Black's one scored move uses mover POV (-100 -> -120), giving 95.656171159316.
  // Missing evaluations do not enter the count; CPL does not supply the after score.
  const summary = computeSummary(analysis, "white", { white_username: "white", black_username: "black" });
  expect(summary.myAccuracy).toBeCloseTo(16.228125305159, 10);
  expect(summary.opponentAccuracy).toBeCloseTo(91.980365828422, 10);

  const blackOwner = computeSummary(analysis, "BLACK", { white_username: "white", black_username: "black" });
  expect(blackOwner.myAccuracy).toBe(summary.opponentAccuracy);
  expect(blackOwner.opponentAccuracy).toBe(summary.myAccuracy);

  analysis.moves = analysis.moves.map(move => ({ ...move, cpBefore: 1500, cpAfter: -1500,
    mateBefore: null, mateAfter: null, cpl: 2000 }));
  const worst = computeSummary(analysis, "white", { white_username: "white", black_username: "black" });
  expect(worst.myAccuracy).toBe(0);
  analysis.moves = analysis.moves.map(move => ({ ...move, cpAfter: move.cpBefore, cpl: 0 }));
  expect(computeSummary(analysis, "white", { white_username: "white", black_username: "black" }).myAccuracy).toBe(100);

  analysis.moves = analysis.moves.map(move => ({ ...move, cpBefore: null, cpl: null }));
  const unscored = computeSummary(analysis, "white", { white_username: "white", black_username: "black" });
  expect(unscored.myAccuracy).toBe(0);
  expect(unscored.opponentAccuracy).toBe(0);
  analysis.moves = [];
  expect(computeSummary(analysis, "white", { white_username: "white", black_username: "black" }).myAccuracy).toBe(0);
});

test("a short game with one blunder retains credit for its other moves", () => {
  const analysis = minimalAnalysis("perfect-with-blunder");
  const template = analysis.moves[0];
  // Eleven perfect White moves and one blunder. Lichess's harmonic/volatility mix collapses this score.
  analysis.moves = Array.from({ length: 24 }, (_, i) => ({
    ...template, ply: i + 1, fenBefore: i % 2 === 0 ? START_FEN : AFTER_E4,
    cpBefore: i === 23 ? -1000 : 0, cpAfter: i >= 22 ? -1000 : 0,
    cpl: i === 22 ? 1000 : 0, classification: i === 22 ? "blunder" : "best",
  }));
  const summary = computeSummary(analysis, "white", { white_username: "white", black_username: "black" });
  // Plain mean (1100 + 16.488588619021)/12, length adjustment -4*ln(12/30).
  expect(summary.myAccuracy).toBeCloseTo(85.151803511764, 10);
  expect(summary.myAccuracy).toBeGreaterThan(80);
  expect(summary.opponentAccuracy).toBe(100);
  expect(summary.counts.blunder).toBe(1);
});

test("accuracy maps mates to its own range and retains the winner at mate zero", () => {
  const analysis = minimalAnalysis("mate-accuracy");
  const move = analysis.moves[0];
  Object.assign(move, { cpBefore: 1000, mateBefore: 3, cpAfter: 1000, mateAfter: null });
  // Losing forced mate to +1000 is a loss under the accuracy curve despite unchanged capped CPL.
  const game = { white_username: "white", black_username: "black" };
  expect(computeSummary(analysis, "white", game).myAccuracy).toBeCloseTo(6.248654252360, 10);
  expect(computeSummary(analysis, "white", game).counts.best).toBe(1);
  Object.assign(move, { cpBefore: -1000, mateBefore: -3, cpAfter: -1000, fenBefore: AFTER_E4 });
  expect(computeSummary(analysis, "black", game).myAccuracy).toBeCloseTo(6.248654252360, 10);

  Object.assign(move, { cpBefore: -1000, mateBefore: null, cpAfter: -1000, mateAfter: 0, fenBefore: START_FEN });
  expect(computeSummary(analysis, "white", game).myAccuracy).toBeCloseTo(6.248654252360, 10);
  Object.assign(move, { cpBefore: 1000, cpAfter: 1000, fenBefore: AFTER_E4 });
  expect(computeSummary(analysis, "black", game).myAccuracy).toBeCloseTo(6.248654252360, 10);
  move.fenBefore = START_FEN;
  expect(computeSummary(analysis, "white", game).myAccuracy).toBe(100);
});

test("summary migration refreshes version-six accuracy, reclassifies and preserves updated_at", () => {
  const username = "mig-user";
  const uuid = "mig-game";
  insertGame(uuid, { white_username: username, black_username: "opp" });
  const white: MoveAnalysis = {
    ply: 1, san: "e4", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "e2e4",
    cpBefore: 900, cpAfter: 600, mateBefore: null, mateAfter: null, cpl: 0, classification: "best",
    // The played move is the engine's second line, so the old centipawn rule called it a blunder.
    lines: [
      { uci: "d2d4", san: "d4", cp: 900, mate: null, pv: ["d2d4"] },
      { uci: "e2e4", san: "e4", cp: 600, mate: null, pv: ["e2e4"] },
    ],
  };
  const black: MoveAnalysis = {
    ply: 2, san: "e5", fenBefore: AFTER_E4, fenAfter: AFTER_E4, uci: "e7e5",
    cpBefore: 40, cpAfter: 40, mateBefore: null, mateAfter: null, cpl: 0, classification: "best",
    lines: [{ uci: "e7e5", san: "e5", cp: 40, mate: null, pv: ["e7e5"] }],
  };
  const analysis: GameAnalysis = {
    gameUuid: uuid,
    engine: { name: "x", version: "y", depth: 1, multiPv: 6 },
    moves: [white, black],
    summary: { myAccuracy: 0, myCpl: 0, opponentAccuracy: 0, counts: { best: 2, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0 } },
  };
  insertAnalysis(uuid, username, "done", JSON.stringify(analysis), { summary_version: 6, updated_at: 4242 });

  expect(SUMMARY_VERSION).toBe(7);
  expect(migrateSummaries()).toBe(1);

  const row = db.query<{ data: string; my_accuracy: number; my_cpl: number; my_counts: string; summary_version: number; updated_at: number }, [string]>(
    "SELECT data, my_accuracy, my_cpl, my_counts, summary_version, updated_at FROM analyses WHERE game_uuid = ?"
  ).get(uuid)!;
  expect(row.updated_at).toBe(4242);
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  const stored = JSON.parse(row.data) as GameAnalysis;
  expect(stored.moves[0].cpl).toBe(300);
  expect(stored.moves[0].classification).toBe("inaccuracy");
  // The unchanged verdict is "inaccuracy"; the separate accuracy curve scores this move 66.667277560599.
  expect(stored.summary.myAccuracy).toBeCloseTo(24.377889100597, 10);
  expect(stored.summary.opponentAccuracy).toBe(100);
  expect(row.my_accuracy).toBeCloseTo(stored.summary.myAccuracy, 10);
  expect(row.my_cpl).toBe(300);
  expect((JSON.parse(row.my_counts) as Record<string, number>).inaccuracy).toBe(1);

  // A second run is a no-op.
  expect(migrateSummaries()).toBe(0);
  const again = db.query<{ summary_version: number; updated_at: number }, [string]>(
    "SELECT summary_version, updated_at FROM analyses WHERE game_uuid = ?"
  ).get(uuid)!;
  expect(again).toEqual({ summary_version: SUMMARY_VERSION, updated_at: 4242 });
});

test("decisive engine scores are capped before measuring centipawn loss", () => {
  const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0 };
  const decisive = (uuid: string, cpBefore: number, playedCp: number): GameAnalysis => ({
    gameUuid: uuid,
    engine: { name: "x", version: "y", depth: 1, multiPv: 6 },
    moves: [{
      ply: 1, san: "e4", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "e2e4",
      cpBefore, cpAfter: 2000, mateBefore: null, mateAfter: null, cpl: 5000, classification: "blunder",
      lines: [
        { uci: "d2d4", san: "d4", cp: 9000, mate: null, pv: ["d2d4"] },
        { uci: "e2e4", san: "e4", cp: playedCp, mate: null, pv: ["e2e4"] },
      ],
    }],
    summary: { myAccuracy: 0, myCpl: 0, opponentAccuracy: 0, counts: { ...counts } },
  });

  // +9000 to +2000 are both winning by more than a mate: no loss at all.
  const winning = decisive("cap-win", 9000, 2000);
  repairAnalysis(winning, "me", { white_username: "me", black_username: "opp", pgn: "1. e4 *" });
  const won = winning.moves[0];
  expect(won.cpl).toBe(0);
  expect(["inaccuracy", "mistake", "blunder"]).not.toContain(won.classification);
  expect(won.cpBefore).toBe(9000);
  expect(won.cpAfter).toBe(2000);
  expect(won.lines.find(line => line.uci === "e2e4")!.cp).toBe(2000);

  // +600 to a forced loss stays a real blunder of 1600, not 9600.
  const losing = decisive("cap-loss", 600, -9000);
  repairAnalysis(losing, "me", { white_username: "me", black_username: "opp", pgn: "1. e4 *" });
  const lost = losing.moves[0];
  expect(lost.cpl).toBe(1600);
  expect(lost.classification).toBe("blunder");
  expect(lost.cpBefore).toBe(600);
  expect(lost.lines.find(line => line.uci === "e2e4")!.cp).toBe(-9000);
});

test("summary migration v2 caps cpl and refreshes decision nextTenPlyCpl", () => {
  const username = "mig2-user";
  const uuid = "mig2-game";
  insertGame(uuid, { white_username: username, black_username: "opp", end_time: 1000 });
  const decisive: MoveAnalysis = {
    ply: 1, san: "e4", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "e2e4",
    cpBefore: 9000, cpAfter: 2000, mateBefore: null, mateAfter: null, cpl: 5000, classification: "blunder",
    lines: [
      { uci: "d2d4", san: "d4", cp: 9000, mate: null, pv: ["d2d4"] },
      { uci: "e2e4", san: "e4", cp: 2000, mate: null, pv: ["e2e4"] },
    ],
  };
  const follow: MoveAnalysis = {
    ply: 3, san: "Nf3", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "g1f3",
    cpBefore: 300, cpAfter: 200, mateBefore: null, mateAfter: null, cpl: 500, classification: "blunder",
    lines: [{ uci: "g1f3", san: "Nf3", cp: 200, mate: null, pv: ["g1f3"] }],
  };
  const analysis: GameAnalysis = {
    gameUuid: uuid,
    engine: { name: "x", version: "y", depth: 1, multiPv: 6 },
    moves: [decisive, follow],
    summary: { myAccuracy: 0, myCpl: 0, opponentAccuracy: 0, counts: { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 2, book: 0 } },
  };
  insertAnalysis(uuid, username, "done", JSON.stringify(analysis), { summary_version: 1, updated_at: 7777 });
  const candidates = [candidate("d2d4", 9000, 0), candidate("e2e4", 2000, 1)];
  const decision: Decision = {
    gameUuid: uuid, playedAt: 1000, ply: 1, fen: START_FEN, played: "e2e4", candidates,
    clockLeft: null, timeSpent: null, phase: "opening", nextTenPlyCpl: 999,
  };
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 1, JSON.stringify(decision)]);

  expect(migrateSummaries()).toBeGreaterThanOrEqual(1);

  const row = db.query<{ data: string; my_cpl: number; summary_version: number; updated_at: number }, [string]>(
    "SELECT data, my_cpl, summary_version, updated_at FROM analyses WHERE game_uuid = ?"
  ).get(uuid)!;
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  expect(row.updated_at).toBe(7777);
  expect(row.my_cpl).toBe(50);
  const stored = JSON.parse(row.data) as GameAnalysis;
  expect(stored.moves[0].cpl).toBe(0);
  expect(stored.moves[1].cpl).toBe(100);

  const decisionRow = db.query<{ data: string }, [string, string, number]>(
    "SELECT data FROM decisions WHERE username = ? AND game_uuid = ? AND ply = ?"
  ).get(username, uuid, 1)!;
  const storedDecision = JSON.parse(decisionRow.data) as Decision;
  expect(storedDecision.nextTenPlyCpl).toBe(100);
  expect(storedDecision).toEqual(buildDecisions(stored, username, { white_username: username, pgn: "1. e4 e5", time_control: "600", end_time: 1000 })[0]);

  expect(migrateSummaries()).toBe(0);
  const after = db.query<{ data: string; summary_version: number; updated_at: number }, [string]>(
    "SELECT data, summary_version, updated_at FROM analyses WHERE game_uuid = ?"
  ).get(uuid)!;
  expect(after).toEqual({ data: row.data, summary_version: SUMMARY_VERSION, updated_at: 7777 });
});

test("migration replaces repaired decisions and obsolete plies and keeps the stale profile visible", () => {
  const username = "repair-decisions";
  const uuid = "repair-decisions-game";
  insertGame(uuid, { white_username: username });
  const analysis = minimalAnalysis(uuid);
  analysis.moves[0].cpBefore = 100;
  analysis.moves[0].lines = ["d2d4", "g1f3", "c2c4", "b1c3", "g2g3", "d2d3", "e2e4"].map((uci, i) =>
    ({ uci, san: uci, cp: i === 6 ? 600 : 100 - 10 * i, mate: null, pv: [uci] }));
  insertAnalysis(uuid, username, "done", JSON.stringify(analysis), { summary_version: SUMMARY_VERSION - 1, updated_at: 4242 });
  const oldDecision = buildDecisions(analysis, username, { white_username: username, pgn: "1. e4 e5", time_control: "600" })[0];
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 1, JSON.stringify(oldDecision)]);
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, JSON.stringify({ ...oldDecision, ply: 99 })]);
  db.run("INSERT INTO decisions VALUES ('other-player', ?, ?, ?)", [uuid, 1, JSON.stringify(oldDecision)]);
  const profile = trainProfile(username, []);
  saveProfile(profile, profileSignature(username));
  expect(migrateSummaries()).toBeGreaterThanOrEqual(1);
  const row = db.query<{ data: string; updated_at: number }, [string]>("SELECT data, updated_at FROM analyses WHERE game_uuid = ?").get(uuid)!;
  const stored = JSON.parse(row.data) as GameAnalysis;
  const decisionRows = db.query<{ data: string }, [string, string]>("SELECT data FROM decisions WHERE username = ? AND game_uuid = ? ORDER BY ply").all(username, uuid);
  expect(decisionRows.map(row => JSON.parse(row.data) as Decision)).toEqual(buildDecisions(stored, username, { white_username: username, pgn: "1. e4 e5", time_control: "600", end_time: 0 }));
  expect(stored.moves[0].lines[6].cp).toBe(50);
  expect(stored.moves[0].cpl).toBe(50);
  expect(row.updated_at).toBe(4242);
  expect(db.query("SELECT 1 FROM decisions WHERE username = 'other-player' AND game_uuid = ?").get(uuid)).not.toBeNull();
  let spawns = 0;
  const read = readStyleProfile(username, () => { spawns++; });
  expect(read.profile).toEqual(profile);
  expect(read.updating).toBe(true);
  expect(spawns).toBe(1);
  expect(migrateSummaries()).toBe(0);
});

test("all shared-game endpoints report the requested side without changing the saved analysis", async () => {
  const uuid = "viewer-game";
  const white = "viewer-white";
  const black = "viewer-black";
  insertGame(uuid, { white_username: white, black_username: black });
  const analysis = minimalAnalysis(uuid);
  analysis.moves[0].cpBefore = 0;
  analysis.moves[0].cpAfter = -300;
  analysis.moves[0].lines = [];
  analysis.moves[0].cpl = 300;
  analysis.moves[0].classification = "blunder";
  analysis.moves.push({
    ...analysis.moves[0], ply: 2, san: "e5", uci: "e7e5", fenBefore: AFTER_E4,
    cpBefore: -300, cpAfter: -300, cpl: 0, classification: "best", lines: [],
  });
  const game = { white_username: white, black_username: black };
  analysis.summary = computeSummary(analysis, white, game);
  const data = JSON.stringify(analysis);
  insertAnalysis(uuid, white.toUpperCase(), "done", data, {
    my_accuracy: analysis.summary.myAccuracy, my_cpl: analysis.summary.myCpl,
    my_counts: JSON.stringify(analysis.summary.counts), summary_version: SUMMARY_VERSION,
  });
  for (const username of [white.toUpperCase(), black.toUpperCase()]) {
    const expected = computeSummary(analysis, username, game);
    const list = await (await app.request(`/api/games?username=${username}`)).json() as GameSummary[];
    const detail = await (await app.request(`/api/games/${uuid}?username=${username}`)).json() as GameDetail;
    const stats = await (await app.request(`/api/profile/${username}`)).json() as ProfileStats;
    const response = await (await app.request(`/api/analysis/${uuid}?username=${username}`)).json() as { analysis: GameAnalysis };
    for (const shown of [list.find(game => game.uuid === uuid)!, detail]) {
      expect(shown.myAccuracy).toBe(expected.myAccuracy);
      expect(shown.myCpl).toBe(expected.myCpl);
      expect(shown.myCounts).toEqual({ inaccuracy: expected.counts.inaccuracy, mistake: expected.counts.mistake, blunder: expected.counts.blunder });
    }
    expect(stats.avgAccuracy).toBe(expected.myAccuracy);
    expect(stats.avgCpl).toBe(expected.myCpl);
    expect(response.analysis.summary).toEqual(expected);
  }
  const defaultDetail = await (await app.request(`/api/games/${uuid}`)).json() as GameDetail;
  const defaultAnalysis = await (await app.request(`/api/analysis/${uuid}`)).json() as { analysis: GameAnalysis };
  expect(defaultDetail.myAccuracy).toBe(analysis.summary.myAccuracy);
  expect(defaultAnalysis.analysis.summary).toEqual(analysis.summary);
  expect(db.query<{ data: string }, [string]>("SELECT data FROM analyses WHERE game_uuid = ?").get(uuid)!.data).toBe(data);
});

test("games and profile read mirrored columns, results and queue counts", async () => {
  const username = "list-user";
  insertGame("api-g1", { white_username: username, black_username: "opp", white_result: "win", black_result: "loss", end_time: 5000, url: "https://chess.com/g1", opening: "Giuoco Piano Game 4.O O d6 5.c3 Nf6" });
  insertGame("api-g2", { white_username: "opp", black_username: username, white_result: "win", black_result: "draw", end_time: 4000 });
  insertGame("api-g3", { white_username: username, black_username: "opp", white_result: "loss", black_result: "win", end_time: 3000 });
  insertGame("api-g4", { white_username: "opp", black_username: username, white_result: "loss", black_result: "win", end_time: 2000 });
  insertGame("api-g5", { white_username: username, black_username: "opp", white_result: "draw", black_result: "draw", end_time: 1000 });
  insertAnalysis("api-g1", username, "done", "{}", {
    my_accuracy: 91.5, my_cpl: 42,
    my_counts: JSON.stringify({ best: 5, excellent: 2, good: 1, inaccuracy: 3, mistake: 1, blunder: 4, book: 0 }),
    summary_version: 1,
  });
  insertAnalysis("api-g2", username, "done", "{}", { my_accuracy: 80.5, my_cpl: 60, my_counts: JSON.stringify({ inaccuracy: 0, mistake: 0, blunder: 0 }), summary_version: 1 });
  insertAnalysis("api-g3", username, "pending", null);
  insertAnalysis("api-g4", username, "running", null);
  insertAnalysis("api-g5", username, "error", null);

  const games = await (await app.request(`/api/games?username=${username}`)).json() as Array<{
    uuid: string; myAccuracy?: number; myCounts?: { inaccuracy: number; mistake: number; blunder: number };
    url?: string; opening?: string; analyzed: boolean;
  }>;
  const g1 = games.find((game) => game.uuid === "api-g1")!;
  expect(g1.myAccuracy).toBe(91.5);
  expect(g1.myCounts).toEqual({ inaccuracy: 3, mistake: 1, blunder: 4 });
  expect(g1.url).toBe("https://chess.com/g1");
  expect(g1.opening).toBe("Giuoco Piano Game");
  expect(g1.analyzed).toBe(true);
  expect(games.find((game) => game.uuid === "api-g3")!.analyzed).toBe(false);

  const stats = await (await app.request(`/api/profile/${username}`)).json() as {
    games: number; wins: number; draws: number; losses: number; winRate: number | null;
    analyzedGames: number; avgAccuracy: number | null; avgCpl: number | null;
    queue: { pending: number; running: number; failed: number };
  };
  expect(stats.games).toBe(5);
  expect(stats.wins).toBe(2);
  expect(stats.draws).toBe(2);
  expect(stats.losses).toBe(1);
  expect(stats.winRate).toBeCloseTo(2 / 5, 10);
  expect(stats.analyzedGames).toBe(2);
  expect(stats.avgAccuracy).toBeCloseTo((91.5 + 80.5) / 2, 10);
  expect(stats.avgCpl).toBeCloseTo((42 + 60) / 2, 10);
  expect(stats.queue).toEqual({ pending: 1, running: 1, failed: 1 });
});

test("cancel deletes fresh queue rows and restores requeued finished rows", async () => {
  const username = "cancel-user";
  insertGame("cancel-g1", { white_username: username });
  insertGame("cancel-g2", { white_username: username });
  insertGame("cancel-g3", { white_username: username });
  insertAnalysis("cancel-g1", username, "pending", null);
  insertAnalysis("cancel-g2", username, "pending", "{}", { summary_version: 1 });
  insertAnalysis("cancel-g3", username, "running", null);

  const response = await app.request("/api/analyze/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  expect(await response.json()).toEqual({ cancelled: 2 });

  expect(db.query("SELECT game_uuid FROM analyses WHERE game_uuid = 'cancel-g1'").get()).toBeNull();
  expect((db.query<{ status: string }, []>("SELECT status FROM analyses WHERE game_uuid = 'cancel-g2'").get())!.status).toBe("done");
  expect((db.query<{ status: string }, []>("SELECT status FROM analyses WHERE game_uuid = 'cancel-g3'").get())!.status).toBe("running");
});

test("recommend route returns the same recommendation as the direct call", async () => {
  const username = "rec-user";
  const decision: Decision = {
    gameUuid: "rec-game", playedAt: 1000, ply: 1, fen: START_FEN, played: "d2d4",
    candidates: [candidate("e2e4", 25, 0), candidate("d2d4", 10, 1), candidate("a2a3", -100, 2)],
    clockLeft: null, timeSpent: null, phase: "opening", nextTenPlyCpl: null,
  };
  insertGame("rec-game", { white_username: username });
  insertAnalysis("rec-game", username, "done", "{}", { summary_version: 1 });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, "rec-game", 1, JSON.stringify(decision)]);
  const profile: StyleProfile = {
    username, status: "confirmed", enoughData: true, pValue: 0.01, gainPp: 5, modelOnly: 10, engineOnly: 5,
    folds: [], selectedFeatures: ["trades"], ablations: [], recencyHalfLifeDays: 182.625,
    decisions: 100, eligibleDecisions: 100, trainingGames: 20, heldOutGames: 20, heldOutDecisions: 100,
    baselineMatch: 0.5, modelMatch: 0.6, weights: { ...zero, trades: 1 }, scales: ones, lambda: 30, traits: [],
  };
  saveProfile(profile, profileSignature(username));

  const direct = recommend(decision, profile, 30, true);
  const response = await app.request(`/api/recommend/rec-game/1?username=${username}&tolerance=30&mode=preference`);
  expect(await response.json()).toEqual(direct);
  expect(direct.forYou?.uci).toBe("d2d4");
});

test("readStyleProfile returns a stale profile immediately and spawns once", () => {
  const username = "stale-user";
  const stored = trainProfile(username, []);
  saveProfile(stored, "stale-signature");
  let calls = 0;
  const spawner = () => { calls += 1; };

  const first = readStyleProfile(username, spawner);
  const second = readStyleProfile(username, spawner);

  expect(first.updating).toBe(true);
  expect(second.updating).toBe(true);
  expect(first.profile).toEqual(stored);
  expect(calls).toBe(1);
});

test("a failed trainer spawn never rejects and frees the username", () => {
  const username = "spawn-user";
  saveProfile(trainProfile(username, []), "stale");
  let calls = 0;
  const spawner = makeTrainSpawner(() => { calls += 1; throw new Error("no bun"); });

  expect(() => readStyleProfile(username, spawner)).not.toThrow();
  expect(() => readStyleProfile(username, spawner)).not.toThrow();
  expect(calls).toBe(2);
});

test("queueAnalysis tolerates a NULL stored username and queues valid games", async () => {
  const username = "null-user";
  const scheduled: string[] = [];
  setTrainingScheduler((name) => scheduled.push(name));
  try {
    // Drop leftovers from earlier tests so the queue only sees our two games.
    db.run("DELETE FROM analyses WHERE status = 'pending'");
    db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES (?, ?, NULL, ?)", ["null-username-game", "1. e4 e5", "someone"]);
    db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES (?, ?, ?, ?)", ["unparseable-game", "not a pgn", username, "opp"]);
    expect(queueAnalysis(username, ["null-username-game", "unparseable-game", "missing-game"])).toBe(1);
    // The unparseable PGN fails before any engine search; wait for that outcome.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = db.query<{ status: string }, [string]>("SELECT status FROM analyses WHERE game_uuid = ?").get("unparseable-game");
      if (row?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The NULL-username game is not this player's, so no row is created for it.
    expect(db.query("SELECT game_uuid FROM analyses WHERE game_uuid = 'null-username-game'").get()).toBeNull();
    expect(db.query("SELECT game_uuid FROM analyses WHERE game_uuid = 'missing-game'").get()).toBeNull();
    const failed = db.query<{ status: string; username: string }, []>(
      "SELECT status, username FROM analyses WHERE game_uuid = 'unparseable-game'"
    ).get()!;
    expect(failed.status).toBe("error");
    expect(failed.username).toBe(username);
  } finally {
    setTrainingScheduler();
    db.run("DELETE FROM analyses WHERE username = ?", [username]);
  }
});

test("finishing the last queued item schedules one background training run", async () => {
  const username = "idle-user";
  const scheduled: string[] = [];
  setTrainingScheduler((name) => scheduled.push(name));
  try {
    db.run("DELETE FROM analyses WHERE status = 'pending'");
    db.run("INSERT INTO analyses (game_uuid, username, status, updated_at) VALUES (?, ?, 'pending', ?)", ["idle-missing-game", username, Date.now()]);
    pump();
    // The idle scheduler defers its spawn slightly to avoid shutdown races.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(scheduled).toEqual([username]);
  } finally {
    setTrainingScheduler();
  }
});

test("queueAnalysis skips done, pending and running rows and retries only errors", async () => {
  const username = "queue-skip-user";
  try {
    db.run("DELETE FROM analyses WHERE status = 'pending'");
    for (const id of ["skip-done", "skip-pending", "skip-running", "skip-error", "skip-new"]) {
      db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES (?, 'not a pgn', ?, 'opp')", [id, username]);
    }
    insertAnalysis("skip-done", username, "done", "{}", { summary_version: 2 });
    insertAnalysis("skip-pending", username, "pending", null);
    insertAnalysis("skip-running", username, "running", null);
    insertAnalysis("skip-error", username, "error", null);

    const queued = queueAnalysis(username, ["skip-done", "skip-pending", "skip-running", "skip-error", "skip-new", "skip-done"]);
    expect(queued).toBe(2);

    // A finished game keeps its saved analysis; only error and new rows run.
    const done = db.query<{ status: string; data: string }, [string]>("SELECT status, data FROM analyses WHERE game_uuid = ?").get("skip-done")!;
    expect(done.status).toBe("done");
    expect(done.data).toBe("{}");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = db.query<{ status: string }, []>("SELECT status FROM analyses WHERE game_uuid IN ('skip-error','skip-new')").all();
      if (rows.length === 2 && rows.every((row) => row.status === "error")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const retried = db.query<{ game_uuid: string; status: string }, []>(
      "SELECT game_uuid, status FROM analyses WHERE game_uuid IN ('skip-error','skip-new')"
    ).all();
    expect(retried.sort((a, b) => a.game_uuid.localeCompare(b.game_uuid))).toEqual([
      { game_uuid: "skip-error", status: "error" },
      { game_uuid: "skip-new", status: "error" },
    ]);
  } finally {
    db.run("DELETE FROM analyses WHERE username = ?", [username]);
    db.run("DELETE FROM games WHERE uuid LIKE 'skip-%'");
  }
});

test("usernames are trimmed and whitespace-only is rejected", async () => {
  const username = "trim-user";
  insertGame("trim-g1", { white_username: username, black_username: "opp" });

  const games = (await (await app.request("/api/games?username=%20trim-user%20")).json()) as Array<{ uuid: string }>;
  expect(games.some((game) => game.uuid === "trim-g1")).toBe(true);

  const profile = await app.request("/api/profile/%20trim-user%20");
  expect(profile.status).toBe(200);
  expect(((await profile.json()) as { games: number }).games).toBeGreaterThanOrEqual(1);

  for (const url of ["/api/games?username=%20%20", "/api/profile/%20%20", "/api/style/%20%20", "/api/games"]) {
    expect((await app.request(url)).status).toBe(400);
  }
});

test("analysis route reports a known unanalyzed game instead of a 404 error", async () => {
  insertGame("unanalyzed-game", { white_username: "contract-user" });

  const known = await app.request("/api/analysis/unanalyzed-game");
  expect(known.status).toBe(200);
  expect(await known.json()).toEqual({ status: "unanalyzed" });

  const unknown = await app.request("/api/analysis/no-such-game");
  expect(unknown.status).toBe(404);
  expect(typeof ((await unknown.json()) as { error?: unknown }).error).toBe("string");
});

test("NULL game usernames do not crash the profile route or the summary migration", async () => {
  const uuid = "null-name-game";
  db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES (?, '1. e4 e5', NULL, 'null-name-opp')", [uuid]);
  insertAnalysis(uuid, "null-name-opp", "done", JSON.stringify(minimalAnalysis(uuid)), { summary_version: 0 });

  expect(() => migrateSummaries()).not.toThrow();
  const migrated = db.query<{ summary_version: number }, [string]>("SELECT summary_version FROM analyses WHERE game_uuid = ?").get(uuid)!;
  expect(migrated.summary_version).toBe(SUMMARY_VERSION);

  const profile = await app.request("/api/profile/null-name-opp");
  expect(profile.status).toBe(200);
  expect(((await profile.json()) as { games: number }).games).toBeGreaterThanOrEqual(1);
});

test("a corrupt analysis row is logged and skipped without blocking the migration", () => {
  const username = "corrupt-user";
  insertGame("corrupt-bad", { white_username: username });
  insertGame("corrupt-partial", { white_username: username });
  insertGame("corrupt-good", { white_username: username });
  db.run(
    "INSERT INTO analyses (game_uuid, username, status, data, summary_version, updated_at) VALUES ('corrupt-bad', ?, 'done', '{not json', 0, 0)",
    [username]
  );
  // Fail the decision insert (decisions are replaced before the analyses
  // UPDATE) to test per-game savepoint rollback.
  const partialData = JSON.stringify(minimalAnalysis("corrupt-partial"));
  insertAnalysis("corrupt-partial", username, "done", partialData, { summary_version: 0 });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, "corrupt-partial", 1, "{not json"]);
  insertAnalysis("corrupt-good", username, "done", JSON.stringify(minimalAnalysis("corrupt-good")), { summary_version: 0 });

  const beforePartialDecisions = db.query<{ ply: number; data: string }, [string]>("SELECT ply, data FROM decisions WHERE username = ? AND game_uuid = 'corrupt-partial' ORDER BY ply").all(username);
  db.run(`CREATE TEMP TRIGGER reject_migration_decision BEFORE INSERT ON decisions
    WHEN NEW.game_uuid = 'corrupt-partial' BEGIN SELECT RAISE(FAIL, 'fixture insert failure'); END`);
  try { expect(() => migrateSummaries()).not.toThrow(); }
  finally { db.run("DROP TRIGGER reject_migration_decision"); }
  expect(db.query<{ summary_version: number }, []>("SELECT summary_version FROM analyses WHERE game_uuid = 'corrupt-bad'").get()!.summary_version).toBe(0);
  const partial = db.query<{ data: string; summary_version: number }, []>(
    "SELECT data, summary_version FROM analyses WHERE game_uuid = 'corrupt-partial'"
  ).get()!;
  expect(partial.data).toBe(partialData);
  expect(partial.summary_version).toBe(0);
  // The savepoint rolled back the DELETE too, so the malformed pre-existing
  // decision row survives the failed migration attempt.
  expect(db.query<{ ply: number; data: string }, [string]>("SELECT ply, data FROM decisions WHERE username = ? AND game_uuid = 'corrupt-partial' ORDER BY ply").all(username)).toEqual(beforePartialDecisions);
  expect(db.query<{ data: string }, [string]>("SELECT data FROM decisions WHERE username = ? AND game_uuid = 'corrupt-partial' AND ply = 1").get(username)!.data).toBe(beforePartialDecisions[0].data);
  expect(db.query<{ summary_version: number }, []>("SELECT summary_version FROM analyses WHERE game_uuid = 'corrupt-good'").get()!.summary_version).toBe(SUMMARY_VERSION);
});

test("a game with a NULL or unparseable PGN returns a clean JSON error", async () => {
  db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES ('bad-pgn-null', NULL, 'p', 'q')");
  db.run("INSERT INTO games (uuid, pgn, white_username, black_username) VALUES ('bad-pgn-text', 'this is not chess', 'p', 'q')");

  for (const uuid of ["bad-pgn-null", "bad-pgn-text"]) {
    const response = await app.request(`/api/games/${uuid}`);
    expect([404, 422]).toContain(response.status);
    expect(typeof ((await response.json()) as { error?: unknown }).error).toBe("string");
  }
});

test("a new analysis revision invalidates old cached evaluations and is stored", async () => {
  db.run("DELETE FROM position_evals");
  const newStartKey = `${engineMeta.version}:${ANALYSIS_REVISION}:6:14:${START_FEN}:`;
  db.run("INSERT OR REPLACE INTO position_evals VALUES (?, ?)", [
    `${engineMeta.version}:6:14:${START_FEN}:`,
    JSON.stringify({ lines: [], bestCpW: 9999, bestMateW: null }),
  ]);
  let calls = 0;
  const evaluator = {
    analyze: async () => {
      calls += 1;
      return [{ uci: "e2e4", san: "e4", cp: 20, mate: null, pv: ["e2e4"] }];
    },
  } as unknown as Engine;

  const position = await analyzePosition(START_FEN, 14, undefined, evaluator);
  expect(calls).toBe(1);
  expect(position.bestCpW).toBe(20);
  expect(db.query("SELECT cache_key FROM position_evals WHERE cache_key = ?").get(newStartKey)).not.toBeNull();

  const analysis = await analyzeGame("revision-game", "1. e4 e5", 14, evaluator);
  expect(analysis.engine.revision).toBe(ANALYSIS_REVISION);
});

test("reanalyze queues only outdated finished analyses and keeps their data", () => {
  const username = "rev-user";
  db.run("DELETE FROM position_evals");
  insertGame("rev-old", { white_username: username });
  insertGame("rev-current", { white_username: username });
  insertGame("rev-empty", { white_username: username });
  const withRevision = (uuid: string, revision?: number): string => {
    const analysis = minimalAnalysis(uuid);
    if (revision !== undefined) analysis.engine.revision = revision;
    return JSON.stringify(analysis);
  };
  insertAnalysis("rev-old", username, "done", withRevision("rev-old", 1), { my_accuracy: 50 });
  insertAnalysis("rev-current", username, "done", withRevision("rev-current", ANALYSIS_REVISION), { my_accuracy: 60 });
  insertAnalysis("rev-empty", username, "done", null, {});
  insertAnalysis("rev-other", "someone-else", "done", withRevision("rev-other", 1), {});
  db.run("INSERT INTO position_evals VALUES (?, ?)", [`${engineMeta.version}:6:14:oldfen:`, "{}"]);
  db.run("INSERT INTO position_evals VALUES (?, ?)", [`${engineMeta.version}:${ANALYSIS_REVISION}:6:14:newfen:`, "{}"]);

  const purged = purgeStaleEvaluations();
  expect(purged).toEqual({ removed: 1, kept: 1 });

  expect(requeueOutdatedAnalyses(username)).toEqual({ queued: 2, current: 1 });
  // A second run must not queue the same games again.
  expect(requeueOutdatedAnalyses(username).queued).toBe(0);

  const old = db.query<{ status: string; data: string }, []>("SELECT status, data FROM analyses WHERE game_uuid = 'rev-old'").get()!;
  expect(old.status).toBe("pending");
  expect((JSON.parse(old.data) as GameAnalysis).engine.revision).toBe(1);
  expect(db.query<{ status: string }, []>("SELECT status FROM analyses WHERE game_uuid = 'rev-other'").get()).toEqual({ status: "done" });

  db.run("DELETE FROM analyses WHERE username = ?", [username]);
});
