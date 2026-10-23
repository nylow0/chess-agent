import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Decision, GameAnalysis } from "@chess/shared";
import { db, SUMMARY_VERSION, getGame } from "./db";
import { ANALYSIS_DEPTH, buildDecisions, repairAnalysis, saveGameAnalysis } from "./worker";
import { engineMeta } from "./engine";
import { profileSignature, saveProfile, trainProfile } from "./style";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const PGN = "1. e4 e5";

// Guarantees failed assertions cannot leak persist-* rows into other suites
// that share this file-backed database.
afterEach(() => {
  db.run("DELETE FROM decisions WHERE game_uuid LIKE 'persist-%'");
  db.run("DELETE FROM analyses WHERE game_uuid LIKE 'persist-%'");
  db.run("DELETE FROM games WHERE uuid LIKE 'persist-%'");
  db.run("DELETE FROM style_profiles WHERE username LIKE 'persist-%'");
});

// Two plies keep one decision per side so the other player's row is meaningful.
function twoPlyAnalysis(uuid: string, cpl: number, classification: "best" | "blunder") {
  return {
    gameUuid: uuid,
    engine: { name: "x", version: "y", depth: 1, multiPv: 6 },
    moves: [
      {
        ply: 1, san: "e4", fenBefore: START_FEN, fenAfter: AFTER_E4, uci: "e2e4",
        cpBefore: 20, cpAfter: 20, mateBefore: null, mateAfter: null, cpl,
        classification,
        lines: [
          { uci: "e2e4", san: "e4", cp: 20, mate: null, pv: ["e2e4"] },
          { uci: "d2d4", san: "d4", cp: 10, mate: null, pv: ["d2d4"] },
        ],
      },
      {
        ply: 2, san: "e5", fenBefore: AFTER_E4, fenAfter: AFTER_E5, uci: "e7e5",
        cpBefore: 20, cpAfter: 20, mateBefore: null, mateAfter: null, cpl,
        classification,
        lines: [
          { uci: "e7e5", san: "e5", cp: 20, mate: null, pv: ["e7e5"] },
          { uci: "e7e6", san: "e6", cp: 10, mate: null, pv: ["e7e6"] },
        ],
      },
    ],
    summary: {
      myAccuracy: 0, myCpl: 0, opponentAccuracy: 0,
      counts: { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0 },
    },
  } as GameAnalysis;
}

function insertPersistGame(uuid: string, white: string, black: string) {
  db.run("DELETE FROM games WHERE uuid = ?", [uuid]);
  db.run(
    "INSERT INTO games (uuid, pgn, time_control, time_class, end_time, white_username, black_username) VALUES (?, ?, '600', 'blitz', 1000, ?, ?)",
    [uuid, PGN, white, black]
  );
}

function insertPersistAnalysis(
  uuid: string,
  username: string,
  status: string,
  data: string | null,
  opts: { updatedAt: number; engineName?: string; engineVersion?: string; depth?: number; error?: string | null; summaryVersion?: number } = { updatedAt: 0 }
) {
  db.run("DELETE FROM analyses WHERE game_uuid = ?", [uuid]);
  db.run(
    "INSERT INTO analyses (game_uuid, username, status, data, engine_name, engine_version, depth, multi_pv, error, my_accuracy, my_cpl, my_counts, summary_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 6, ?, NULL, NULL, NULL, ?, ?)",
    [uuid, username, status, data, opts.engineName ?? null, opts.engineVersion ?? null, opts.depth ?? null, opts.error ?? null, opts.summaryVersion ?? 0, opts.updatedAt]
  );
}

function clearPersist(uuid: string, usernames: string[]) {
  db.run("DELETE FROM decisions WHERE game_uuid = ?", [uuid]);
  db.run("DELETE FROM analyses WHERE game_uuid = ?", [uuid]);
  db.run("DELETE FROM games WHERE uuid = ?", [uuid]);
  for (const username of usernames) db.run("DELETE FROM style_profiles WHERE username = ?", [username.toLowerCase()]);
}

function readAnalysisRow(uuid: string) {
  return db.query<{
    status: string; username: string | null; engine_name: string | null; engine_version: string | null;
    depth: number | null; multi_pv: number | null; data: string | null; error: string | null;
    updated_at: number; my_accuracy: number | null; my_cpl: number | null; my_counts: string | null;
    summary_version: number;
  }, [string]>(
    "SELECT status, username, engine_name, engine_version, depth, multi_pv, data, error, updated_at, my_accuracy, my_cpl, my_counts, summary_version FROM analyses WHERE game_uuid = ?"
  ).get(uuid)!;
}

function readDecisionRows(username: string, uuid: string) {
  return db.query<{ ply: number; data: string }, [string, string]>(
    "SELECT ply, data FROM decisions WHERE username = ? AND game_uuid = ? ORDER BY ply"
  ).all(username, uuid);
}

function readProfileRow(username: string) {
  return db.query<{ signature: string; data: string }, [string]>(
    "SELECT signature, data FROM style_profiles WHERE username = ?"
  ).get(username.toLowerCase());
}

test("completion writes matching data, drops obsolete plies and advances metadata", () => {
  const username = "persist-comp-white";
  const other = "persist-comp-opp";
  const uuid = "persist-comp-game";
  clearPersist(uuid, [username, other]);
  insertPersistGame(uuid, username, other);
  insertPersistAnalysis(uuid, username, "pending", null, { updatedAt: 1000, engineName: "old", engineVersion: "old", depth: 1, error: "old" });
  db.run("UPDATE games SET analyzed = 0 WHERE uuid = ?", [uuid]);
  const input = twoPlyAnalysis(uuid, 0, "best");
  const obsolete = JSON.stringify({ gameUuid: uuid, ply: 99, fen: START_FEN, played: "e2e4", candidates: [], clockLeft: null, timeSpent: null, phase: "opening", nextTenPlyCpl: null });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, obsolete]);
  const otherData = JSON.stringify({ keep: "other-decision" });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [other, uuid, 2, otherData]);
  const profile = trainProfile(username, []);
  saveProfile(profile, profileSignature(username));
  const otherProfile = trainProfile(other, []);
  saveProfile(otherProfile, profileSignature(other));
  const oldSig = readProfileRow(username)!.signature;

  const game = getGame(uuid)!;
  const saved = saveGameAnalysis({ game, username, analysis: structuredClone(input), source: "completion" });
  expect(saved).toBe(1);

  const row = readAnalysisRow(uuid);
  expect(row.status).toBe("done");
  expect(row.username).toBe(username);
  expect(row.error).toBeNull();
  expect(row.engine_name).toBe(engineMeta.name);
  expect(row.engine_version).toBe(engineMeta.version);
  expect(row.depth).toBe(ANALYSIS_DEPTH);
  expect(row.multi_pv).toBe(6);
  expect(row.updated_at).toBeGreaterThan(1000);
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  const stored = JSON.parse(row.data!) as GameAnalysis;
  expect(stored.moves).toHaveLength(2);
  expect(stored.moves[0].cpl).toBe(0);
  expect(row.my_accuracy).toBe(stored.summary.myAccuracy);
  expect(row.my_cpl).toBe(stored.summary.myCpl);
  expect(JSON.parse(row.my_counts!)).toEqual(stored.summary.counts);
  const rows = readDecisionRows(username, uuid);
  expect(rows.map((r) => r.ply)).toEqual([1]);
  expect(rows.map((r) => JSON.parse(r.data) as Decision)).toEqual(
    buildDecisions(stored, username, { white_username: username, pgn: PGN, time_control: "600", end_time: 1000 })
  );
  expect(db.query("SELECT 1 AS x FROM decisions WHERE username = ? AND game_uuid = ? AND ply = 99").get(username, uuid)).toBeNull();
  expect(readDecisionRows(other, uuid)[0].data).toBe(otherData);
  const kept = readProfileRow(username)!;
  expect(JSON.parse(kept.data)).toEqual(profile);
  expect(kept.signature).not.toBe(oldSig);
  expect(kept.signature).not.toBe(profileSignature(username));
  expect(readProfileRow(other)!.data).toBe(JSON.stringify(otherProfile));
  expect((db.query<{ analyzed: number }, [string]>("SELECT analyzed FROM games WHERE uuid = ?").get(uuid))!.analyzed).toBe(1);
  clearPersist(uuid, [username, other]);
});

test("startup-repair preserves timestamps and metadata while replacing decisions", () => {
  const username = "persist-repair-white";
  const other = "persist-repair-opp";
  const uuid = "persist-repair-game";
  clearPersist(uuid, [username, other]);
  insertPersistGame(uuid, username, other);
  const stale = twoPlyAnalysis(uuid, 999, "blunder");
  insertPersistAnalysis(uuid, username, "done", JSON.stringify(stale), {
    updatedAt: 4242, engineName: "keep-engine", engineVersion: "keep-ver", depth: 9, summaryVersion: 0,
  });
  db.run("UPDATE games SET analyzed = 1 WHERE uuid = ?", [uuid]);
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, JSON.stringify({ ply: 99 })]);
  const otherData = JSON.stringify({ keep: "other" });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [other, uuid, 2, otherData]);
  const profile = trainProfile(username, []);
  saveProfile(profile, profileSignature(username));
  const otherProfile = trainProfile(other, []);
  saveProfile(otherProfile, profileSignature(other));

  const game = getGame(uuid)!;
  const saved = saveGameAnalysis({ game, username, analysis: structuredClone(stale), source: "startup-repair" });
  expect(saved).toBe(1);

  const row = readAnalysisRow(uuid);
  expect(row.updated_at).toBe(4242);
  expect(row.engine_name).toBe("keep-engine");
  expect(row.engine_version).toBe("keep-ver");
  expect(row.depth).toBe(9);
  expect(row.status).toBe("done");
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  const stored = JSON.parse(row.data!) as GameAnalysis;
  expect(stored.moves[0].cpl).not.toBe(999);
  expect(stored.moves[0].cpl).toBe(0);
  expect(row.my_cpl).toBe(stored.summary.myCpl);
  expect(readDecisionRows(username, uuid).map((r) => r.ply)).toEqual([1]);
  expect(db.query("SELECT 1 AS x FROM decisions WHERE username = ? AND game_uuid = ? AND ply = 99").get(username, uuid)).toBeNull();
  expect(readDecisionRows(other, uuid)[0].data).toBe(otherData);
  const kept = readProfileRow(username)!;
  expect(JSON.parse(kept.data)).toEqual(profile);
  expect(kept.signature).not.toBe(profileSignature(username));
  expect(readProfileRow(other)!.data).toBe(JSON.stringify(otherProfile));
  expect((db.query<{ analyzed: number }, [string]>("SELECT analyzed FROM games WHERE uuid = ?").get(uuid))!.analyzed).toBe(1);
  clearPersist(uuid, [username, other]);
});

test("startup-repair marks the stored profile stale even when count and timestamp do not change", () => {
  const username = "persist-stable-white";
  const uuid = "persist-stable-game";
  clearPersist(uuid, [username]);
  insertPersistGame(uuid, username, "persist-stable-opp");
  const correct = twoPlyAnalysis(uuid, 0, "best");
  // Pre-store the exact repaired decisions so the save keeps the same count.
  const preview = structuredClone(correct);
  repairAnalysis(preview, username, { white_username: username, black_username: "persist-stable-opp", pgn: PGN });
  insertPersistAnalysis(uuid, username, "done", JSON.stringify(preview), {
    updatedAt: 5555, engineName: "keep", engineVersion: "keep", depth: 9, summaryVersion: 0,
  });
  for (const d of buildDecisions(preview, username, { white_username: username, pgn: PGN, time_control: "600", end_time: 1000 })) {
    db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, d.ply, JSON.stringify(d)]);
  }
  const profile = trainProfile(username, []);
  const beforeSig = profileSignature(username);
  saveProfile(profile, beforeSig);
  expect(readProfileRow(username)!.signature).toBe(beforeSig);

  const game = getGame(uuid)!;
  saveGameAnalysis({ game, username, analysis: structuredClone(correct), source: "startup-repair" });

  // Same ply count and same updated_at, so the count/timestamp aggregate did not move.
  expect(profileSignature(username)).toBe(beforeSig);
  expect(readDecisionRows(username, uuid).map((r) => r.ply)).toEqual([1]);
  expect(readAnalysisRow(uuid).updated_at).toBe(5555);
  const kept = readProfileRow(username)!;
  expect(JSON.parse(kept.data)).toEqual(profile);
  expect(kept.signature).not.toBe(beforeSig);
  clearPersist(uuid, [username]);
});

test("feature-refresh advances updated_at while preserving engine and queue metadata", () => {
  const username = "persist-refresh-white";
  const other = "persist-refresh-opp";
  const uuid = "persist-refresh-game";
  clearPersist(uuid, [username, other]);
  insertPersistGame(uuid, username, other);
  const stale = twoPlyAnalysis(uuid, 999, "blunder");
  insertPersistAnalysis(uuid, username, "done", JSON.stringify(stale), {
    updatedAt: 1000, engineName: "keep-engine", engineVersion: "keep-ver", depth: 5, summaryVersion: 0,
  });
  db.run("UPDATE games SET analyzed = 1 WHERE uuid = ?", [uuid]);
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, JSON.stringify({ ply: 99 })]);
  const otherData = JSON.stringify({ keep: "other" });
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [other, uuid, 2, otherData]);
  const profile = trainProfile(username, []);
  saveProfile(profile, profileSignature(username));

  const game = getGame(uuid)!;
  const saved = saveGameAnalysis({ game, username, analysis: structuredClone(stale), source: "feature-refresh" });
  expect(saved).toBe(1);

  const row = readAnalysisRow(uuid);
  expect(row.updated_at).toBeGreaterThan(1000);
  expect(row.engine_name).toBe("keep-engine");
  expect(row.engine_version).toBe("keep-ver");
  expect(row.depth).toBe(5);
  expect(row.status).toBe("done");
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  const stored = JSON.parse(row.data!) as GameAnalysis;
  expect(stored.moves[0].cpl).toBe(0);
  expect(row.my_cpl).toBe(stored.summary.myCpl);
  expect(row.my_accuracy).toBe(stored.summary.myAccuracy);
  expect(readDecisionRows(username, uuid).map((r) => r.ply)).toEqual([1]);
  expect(readDecisionRows(other, uuid)[0].data).toBe(otherData);
  const kept = readProfileRow(username)!;
  expect(JSON.parse(kept.data)).toEqual(profile);
  expect(kept.signature).not.toBe(profileSignature(username));
  expect((db.query<{ analyzed: number }, [string]>("SELECT analyzed FROM games WHERE uuid = ?").get(uuid))!.analyzed).toBe(1);
  clearPersist(uuid, [username, other]);
});

test("completion from Black's perspective keeps White's decisions and writes one even-ply row", () => {
  const white = "persist-black-white";
  const username = "persist-black-black";
  const uuid = "persist-black-game";
  clearPersist(uuid, [white, username]);
  insertPersistGame(uuid, white, username);
  insertPersistAnalysis(uuid, username, "pending", null, { updatedAt: 1000 });
  const input = twoPlyAnalysis(uuid, 0, "best");

  const game = getGame(uuid)!;
  const saved = saveGameAnalysis({ game, username, analysis: structuredClone(input), source: "completion" });
  expect(saved).toBe(1);
  expect(readDecisionRows(username, uuid).map((r) => r.ply)).toEqual([2]);
  expect(readDecisionRows(white, uuid)).toHaveLength(0);
  const stored = JSON.parse(readAnalysisRow(uuid).data!) as GameAnalysis;
  expect(stored.summary.counts.best).toBe(1);
  clearPersist(uuid, [white, username]);
});

test("completion recreates a missing analyses row with the owner attached", () => {
  const username = "persist-missing-white";
  const other = "persist-missing-opp";
  const uuid = "persist-missing-game";
  clearPersist(uuid, [username, other]);
  insertPersistGame(uuid, username, other);
  // No analyses row at all: queue-then-crash left nothing behind.
  const game = getGame(uuid)!;
  const saved = saveGameAnalysis({ game, username, analysis: structuredClone(twoPlyAnalysis(uuid, 0, "best")), source: "completion" });
  expect(saved).toBe(1);

  const row = readAnalysisRow(uuid);
  expect(row.status).toBe("done");
  expect(row.username).toBe(username);
  expect(row.summary_version).toBe(SUMMARY_VERSION);
  expect(readDecisionRows(username, uuid).map((r) => r.ply)).toEqual([1]);
  clearPersist(uuid, [username, other]);
});

test("a mid-save failure rolls back analysis, decisions and profile freshness together", () => {
  const username = "persist-rollback-white";
  const other = "persist-rollback-opp";
  const uuid = "persist-rollback-game";
  clearPersist(uuid, [username, other]);
  insertPersistGame(uuid, username, other);
  const base = twoPlyAnalysis(uuid, 0, "best");
  insertPersistAnalysis(uuid, username, "pending", JSON.stringify(base), { updatedAt: 7777, engineName: "keep", engineVersion: "keep", depth: 9 });
  const keepDecision = JSON.stringify(
    buildDecisions(base, username, { white_username: username, pgn: PGN, time_control: "600", end_time: 1000 })[0]
  );
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 1, keepDecision]);
  db.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, JSON.stringify({ ply: 99 })]);
  const profile = trainProfile(username, []);
  const freshSig = profileSignature(username);
  saveProfile(profile, freshSig);
  const beforeRow = readAnalysisRow(uuid);
  const beforeDecisions = readDecisionRows(username, uuid);
  const beforeAnalyzed = (db.query<{ analyzed: number }, [string]>("SELECT analyzed FROM games WHERE uuid = ?").get(uuid))!.analyzed;
  const beforeProfile = readProfileRow(username)!;

  // Fail the last write: decisions are replaced before the analyses UPDATE,
  // and the profile signature UPDATE runs after both, so this faults after
  // every stored write has been attempted in the transaction.
  db.run(`CREATE TEMP TRIGGER persist_rollback_fail AFTER UPDATE ON style_profiles WHEN NEW.username = '${username.toLowerCase()}' BEGIN SELECT RAISE(FAIL, 'fixture rollback failure'); END`);
  let error: unknown;
  try {
    const game = getGame(uuid)!;
    saveGameAnalysis({ game, username, analysis: structuredClone(base), source: "completion" });
  } catch (err) {
    error = err;
  } finally {
    db.run("DROP TRIGGER persist_rollback_fail");
  }
  expect(String((error as Error | null)?.message ?? error)).toContain("fixture rollback failure");
  expect(readAnalysisRow(uuid)).toEqual(beforeRow);
  expect(readDecisionRows(username, uuid)).toEqual(beforeDecisions);
  expect((db.query<{ analyzed: number }, [string]>("SELECT analyzed FROM games WHERE uuid = ?").get(uuid))!.analyzed).toBe(beforeAnalyzed);
  const kept = readProfileRow(username)!;
  expect(kept.signature).toBe(freshSig);
  expect(kept.signature).toBe(profileSignature(username));
  expect(kept.data).toBe(beforeProfile.data);
  expect(JSON.parse(kept.data)).toEqual(profile);
  clearPersist(uuid, [username, other]);
});

test("the actual refresh-features script uses an isolated database and repairs consistently", async () => {
  const dir = path.resolve(import.meta.dir, "../../../.artifacts/analysis-persistence-tests");
  mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `${crypto.randomUUID()}.db`);
  const username = "persist-sub-white";
  const other = "persist-sub-opp";
  const uuid = "persist-sub-game";
  const stale = twoPlyAnalysis(uuid, 999, "blunder");
  const staleJson = JSON.stringify(stale);
  const otherDecision = JSON.stringify({ keep: "sub-other" });
  let oldUpdated = 0;
  let oldWhiteSig = "";
  let oldWhiteData = "";
  let oldOtherSig = "";
  let oldOtherData = "";
  const setup = new Database(tempPath);
  try {
    setup.run("PRAGMA journal_mode = WAL;");
    setup.run("PRAGMA busy_timeout = 5000;");
    setup.run("CREATE TABLE IF NOT EXISTS games (uuid TEXT PRIMARY KEY, pgn TEXT, url TEXT, time_control TEXT, time_class TEXT, rated INTEGER, end_time INTEGER, white_username TEXT, white_rating INTEGER, white_result TEXT, black_username TEXT, black_rating INTEGER, black_result TEXT, opening TEXT, analyzed INTEGER DEFAULT 0)");
    setup.run("CREATE TABLE IF NOT EXISTS analyses (game_uuid TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', engine_name TEXT, engine_version TEXT, depth INTEGER, multi_pv INTEGER, data TEXT, error TEXT, updated_at INTEGER, username TEXT, my_accuracy REAL, my_cpl REAL, my_counts TEXT, summary_version INTEGER NOT NULL DEFAULT 0)");
    setup.run("CREATE TABLE IF NOT EXISTS decisions (username TEXT NOT NULL COLLATE NOCASE, game_uuid TEXT NOT NULL, ply INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (username, game_uuid, ply))");
    setup.run("CREATE TABLE IF NOT EXISTS style_profiles (username TEXT PRIMARY KEY COLLATE NOCASE, signature TEXT NOT NULL, data TEXT NOT NULL)");
    setup.run("INSERT INTO games (uuid, pgn, time_control, time_class, end_time, white_username, black_username, analyzed) VALUES (?, ?, '600', 'blitz', 1000, ?, ?, 1)", [uuid, PGN, username, other]);
    setup.run("INSERT INTO analyses (game_uuid, username, status, data, engine_name, engine_version, depth, multi_pv, error, my_accuracy, my_cpl, my_counts, summary_version, updated_at) VALUES (?, ?, 'done', ?, 'sub-keep', 'sub-keep', 5, 6, NULL, 0, 999, '{}', 0, 1234)", [uuid, username, staleJson]);
    setup.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 1, JSON.stringify({ ply: 1, stale: true })]);
    setup.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [username, uuid, 99, JSON.stringify({ ply: 99 })]);
    setup.run("INSERT INTO decisions VALUES (?, ?, ?, ?)", [other, uuid, 2, otherDecision]);
    const sigRow = (name: string) => setup.query<{ n: number; updated: number | null }, [string]>(
      "SELECT COUNT(*) n, MAX(a.updated_at) updated FROM decisions d JOIN analyses a ON a.game_uuid = d.game_uuid WHERE d.username = ? COLLATE NOCASE AND a.status = 'done'"
    ).get(name)!;
    const whiteSig = `v6:${JSON.stringify(sigRow(username))}`;
    const otherSig = `v6:${JSON.stringify(sigRow(other))}`;
    const whiteProfile = JSON.stringify(trainProfile(username, []));
    const otherProfile = JSON.stringify(trainProfile(other, []));
    setup.run("INSERT INTO style_profiles VALUES (?, ?, ?)", [username.toLowerCase(), whiteSig, whiteProfile]);
    setup.run("INSERT INTO style_profiles VALUES (?, ?, ?)", [other.toLowerCase(), otherSig, otherProfile]);
    oldUpdated = 1234;
    oldWhiteSig = whiteSig;
    oldWhiteData = whiteProfile;
    oldOtherSig = otherSig;
    oldOtherData = otherProfile;
  } finally {
    setup.close();
  }

  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "refresh-features.ts")], {
    env: { ...process.env, CHESS_DB_PATH: tempPath },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await proc.exited;
  } finally {
    // A timed-out test must not orphan the child or its temp database.
    if (proc.exitCode === null) proc.kill();
  }
  expect(proc.exitCode).toBe(0);

  const check = new Database(tempPath);
  try {
    const row = check.query<{ data: string; my_accuracy: number; my_cpl: number; my_counts: string; summary_version: number; updated_at: number; engine_name: string; status: string }, [string]>(
      "SELECT data, my_accuracy, my_cpl, my_counts, summary_version, updated_at, engine_name, status FROM analyses WHERE game_uuid = ?"
    ).get(uuid)!;
    expect(row.summary_version).toBe(SUMMARY_VERSION);
    expect(row.updated_at).toBeGreaterThan(oldUpdated);
    expect(row.engine_name).toBe("sub-keep");
    expect(row.status).toBe("done");
    const stored = JSON.parse(row.data) as GameAnalysis;
    expect(stored.moves[0].cpl).toBe(0);
    expect(row.my_cpl).toBe(stored.summary.myCpl);
    expect(JSON.parse(row.my_counts)).toEqual(stored.summary.counts);
    const expected = structuredClone(stale);
    repairAnalysis(expected, username, { white_username: username, black_username: other, pgn: PGN });
    const want = buildDecisions(expected, username, { white_username: username, pgn: PGN, time_control: "600", end_time: 1000 });
    const got = check.query<{ ply: number; data: string }, [string, string]>(
      "SELECT ply, data FROM decisions WHERE username = ? AND game_uuid = ? ORDER BY ply"
    ).all(username, uuid);
    expect(got.map((r) => r.ply)).toEqual([1]);
    expect(got.map((r) => JSON.parse(r.data))).toEqual(want);
    expect(check.query("SELECT 1 AS x FROM decisions WHERE username = ? AND game_uuid = ? AND ply = 99").get(username, uuid)).toBeNull();
    expect(check.query<{ data: string }, [string, string, number]>(
      "SELECT data FROM decisions WHERE username = ? AND game_uuid = ? AND ply = ?"
    ).get(other, uuid, 2)!.data).toBe(otherDecision);
    const whiteRow = check.query<{ signature: string; data: string }, [string]>("SELECT signature, data FROM style_profiles WHERE username = ?").get(username.toLowerCase())!;
    expect(whiteRow.data).toBe(oldWhiteData);
    expect(whiteRow.signature).not.toBe(oldWhiteSig);
    const otherRow = check.query<{ signature: string; data: string }, [string]>("SELECT signature, data FROM style_profiles WHERE username = ?").get(other.toLowerCase())!;
    expect(otherRow.signature).toBe(oldOtherSig);
    expect(otherRow.data).toBe(oldOtherData);
  } finally {
    check.close();
    rmSync(tempPath, { force: true });
    rmSync(`${tempPath}-wal`, { force: true });
    rmSync(`${tempPath}-shm`, { force: true });
  }
}, 15000);
