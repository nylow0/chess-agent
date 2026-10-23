import { afterAll, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { Engine, engine } from "./engine";
import { analyzeGame, analyzePosition, buildDecisions, capFallback, moveAccuracy, repairAnalysis } from "./worker";
import { db } from "./db";
import type { EngineLine } from "@chess/shared";
import { features, moveClocks } from "./features";
import { toGameResult } from "./chesscom";

afterAll(() => engine.kill());

type EngineState = {
  proc: { exitCode: number | null; stdin: { write: (command: string) => number | Promise<number>; flush: () => number | Promise<number> }; kill: () => void } | null;
  onLine: (line: string) => void;
};

test("asynchronous stdin write and flush failures enter the search retry boundary", async () => {
  for (const failure of ["write", "flush"] as const) {
    const instance = new Engine();
    const state = instance as unknown as EngineState;
    let attempts = 0;
    let kills = 0;
    instance.ensureStarted = async () => {
      attempts++;
      state.proc = { exitCode: null, kill: () => { kills++; }, stdin: {
        write: () => failure === "write" ? Promise.reject(new Error("EPIPE write")) : 1,
        flush: () => failure === "flush" ? Promise.reject(new Error("EPIPE flush")) : 1,
      } };
    };
    await expect(instance.analyze(new Chess().fen(), 3)).rejects.toThrow(`EPIPE ${failure}`);
    expect(attempts).toBe(2);
    expect(kills).toBe(2);
  }
});

test("disposal kills directly without racing an asynchronous quit write", () => {
  const instance = new Engine();
  const state = instance as unknown as EngineState;
  let writes = 0;
  let kills = 0;
  state.proc = { exitCode: null, kill: () => { kills++; }, stdin: {
    write: () => { writes++; return Promise.resolve(1); }, flush: () => 1,
  } };
  instance.kill();
  expect(writes).toBe(0);
  expect(kills).toBe(1);
});

test("replacing a live search process triggers retry without waiting on the replacement", async () => {
  const instance = new Engine();
  const state = instance as unknown as EngineState;
  let searches = 0;
  instance.ensureStarted = async () => {
    state.proc = { exitCode: null, kill: () => {}, stdin: {
      write: (command) => {
        if (command.trim() === "isready") state.onLine("readyok");
        if (command.startsWith("go ")) {
          searches++;
          if (searches === 1) {
            state.proc = { exitCode: null, kill: () => {}, stdin: { write: () => 1, flush: () => 1 } };
          } else {
            state.onLine("info depth 3 score cp 20 pv e2e4");
            state.onLine("bestmove e2e4");
          }
        }
        return 1;
      }, flush: () => 1,
    } };
  };
  let settled = false;
  const result = instance.analyze(new Chess().fen(), 3).then(lines => { settled = true; return lines; });
  await Bun.sleep(60);
  const retriedImmediately = settled;
  // Let the old implementation settle too, so a failing assertion leaves no pending search.
  if (!settled && state.proc) state.proc.exitCode = 1;
  try {
    expect((await result)[0].cp).toBe(20);
    expect(retriedImmediately).toBe(true);
    expect(searches).toBe(2);
  } finally { instance.kill(); }
});

test("final-ply repetitions zero the played line and post-move score without altering position caches", async () => {
  for (const pgn of [
    "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2",
    '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"]\n\n1... Nf6 2. Nf3 Ng8 3. Ng1 Nf6 4. Nf3 Ng8 5. Ng1 1/2-1/2',
  ]) {
    db.run("DELETE FROM position_evals");
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    const playedByFen = new Map(history.map(move => [move.before, move.from + move.to]));
    const evaluator = new Engine();
    const fallbackFens: string[] = [];
    evaluator.analyze = async (fen, _depth, searchMove) => {
      if (searchMove) fallbackFens.push(fen);
      return new Chess(fen).moves({ verbose: true })
        .filter(move => searchMove ? move.from + move.to === searchMove : move.from + move.to !== playedByFen.get(fen))
        .slice(0, 6).map(move => ({ uci: move.from + move.to, san: move.san, cp: 600, mate: null, pv: [move.from + move.to] }));
    };
    const analysis = await analyzeGame("draw-history", pgn, 3, evaluator);
    const last = analysis.moves.at(-1)!;
    expect(last.cpAfter).toBe(0);
    expect(last.mateAfter).toBeNull();
    expect(last.lines.find(line => line.uci === last.uci)).toMatchObject({ cp: 0, mate: null });
    expect(last.cpl).toBe(600);
    expect(last.classification).toBe("blunder");
    expect(fallbackFens).not.toContain(last.fenBefore);
    const cacheKey = `0.9.0:2:6:3:${last.fenBefore}:`;
    const cached = JSON.parse(db.query<{ data: string }, [string]>("SELECT data FROM position_evals WHERE cache_key = ?").get(cacheKey)!.data) as { lines: EngineLine[] };
    expect(cached.lines.some(line => line.uci === last.uci)).toBe(false);
    expect((await analyzePosition(last.fenAfter, 3, undefined, evaluator)).bestCpW).not.toBe(0);
    const repaired = structuredClone(analysis);
    repaired.moves.at(-1)!.cpAfter = 600;
    repaired.moves.at(-1)!.lines = repaired.moves.at(-1)!.lines.filter(line => line.uci !== last.uci);
    repairAnalysis(repaired, "me", { white_username: "me", black_username: "opp", pgn });
    expect(repaired.moves).toEqual(analysis.moves);
  }
});

test("a mid-game repetition keeps engine scores and the next move's lines through repair", async () => {
  const repetition = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8";
  const pgn = `${repetition} 5. e4 e5 *`;
  const chess = new Chess();
  chess.loadPgn(repetition);
  expect(chess.isThreefoldRepetition()).toBe(true);
  chess.loadPgn(pgn);
  expect(chess.isThreefoldRepetition()).toBe(false);
  db.run("DELETE FROM position_evals");
  const evaluator = new Engine();
  evaluator.analyze = async (fen, _depth, searchMove) => {
    const board = new Chess(fen);
    return board.moves({ verbose: true })
      .filter(move => !searchMove || move.from + move.to === searchMove)
      .slice(0, 6).map(move => ({ uci: move.from + move.to, san: move.san, cp: board.turn() === "w" ? 600 : -600, mate: null, pv: [move.from + move.to] }));
  };
  const analysis = await analyzeGame("mid-game-repetition", pgn, 3, evaluator);
  const repeated = analysis.moves[7];
  const next = analysis.moves[8];
  expect(repeated.cpAfter).toBe(600);
  expect(repeated.lines.find(line => line.uci === repeated.uci)?.cp).toBe(600);
  expect(next.cpBefore).toBe(600);
  expect(next.lines.length).toBeGreaterThan(0);
  expect(next.bestMove).toBeDefined();
  const beforeRepair = structuredClone(analysis.moves);
  repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
  expect(analysis.moves).toEqual(beforeRepair);
});

test("a winning side's rank-one repetition prefers the best alternative and measures its loss", async () => {
  const pgn = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2";
  const chess = new Chess();
  chess.loadPgn(pgn);
  const playedByFen = new Map(chess.history({ verbose: true }).map(move => [move.before, move.from + move.to]));
  for (const cp of [600, -600]) {
    db.run("DELETE FROM position_evals");
    const evaluator = new Engine();
    evaluator.analyze = async (fen, _depth, searchMove) => new Chess(fen).moves({ verbose: true })
      .filter(move => !searchMove || move.from + move.to === searchMove)
      .sort((a, b) => Number(b.from + b.to === playedByFen.get(fen)) - Number(a.from + a.to === playedByFen.get(fen)))
      .slice(0, 6).map((move, i) => ({ uci: move.from + move.to, san: move.san, cp: i === 0 ? cp : cp - 25, mate: null, pv: [move.from + move.to] }));
    const analysis = await analyzeGame("rank-one-draw", pgn, 3, evaluator);
    const last = analysis.moves.at(-1)!;
    const played = last.lines.find(line => line.uci === last.uci)!;
    expect(played.cp).toBe(0);
    expect(last.lines[0].uci === last.uci).toBe(cp < 0);
    expect(last.bestMove).toBe(last.lines[0].uci);
    expect(last.bestMoveSan).toBe(last.lines[0].san);
    expect(last.cpBefore).toBe(cp > 0 ? -575 : 0);
    expect(last.mateBefore).toBeNull();
    expect(analysis.moves.at(-2)!.cpAfter).toBe(last.cpBefore);
    expect(analysis.moves.at(-2)!.mateAfter).toBe(last.mateBefore);
    expect(last.cpl).toBe(cp > 0 ? 575 : 0);
    expect(last.classification).toBe(cp > 0 ? "blunder" : "best");
    const cached = await analyzePosition(last.fenBefore, 3, undefined, evaluator);
    expect(last.lines.map(line => line.uci)).toEqual(cp > 0
      ? [...cached.lines.slice(1).map(line => line.uci), last.uci]
      : cached.lines.map(line => line.uci));
    // Restore history-free metadata to exercise repair of an existing analysis too.
    const legacy = structuredClone(analysis);
    const legacyLast = legacy.moves.at(-1)!;
    legacyLast.lines = structuredClone(cached.lines);
    legacyLast.bestMove = legacyLast.uci;
    legacyLast.bestMoveSan = legacyLast.san;
    legacyLast.cpBefore = cached.bestCpW;
    legacy.moves.at(-2)!.cpAfter = cached.bestCpW;
    repairAnalysis(legacy, "me", { white_username: "me", black_username: "opp", pgn });
    expect(legacy.moves).toEqual(analysis.moves);
    const beforeRepair = structuredClone(analysis.moves);
    repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
    expect(analysis.moves).toEqual(beforeRepair);
    const afterRepair = structuredClone(analysis);
    repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
    expect(analysis).toEqual(afterRepair);
  }
});

test("a losing side's unranked repetition stays best and repair leaves re-sorted fallback scores intact", async () => {
  const pgn = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2";
  const chess = new Chess();
  chess.loadPgn(pgn);
  const playedByFen = new Map(chess.history({ verbose: true }).map(move => [move.before, move.from + move.to]));
  db.run("DELETE FROM position_evals");
  const evaluator = new Engine();
  evaluator.analyze = async (fen, _depth, searchMove) => new Chess(fen).moves({ verbose: true })
    .filter(move => searchMove ? move.from + move.to === searchMove : move.from + move.to !== playedByFen.get(fen))
    .slice(0, 6).map((move, i) => ({ uci: move.from + move.to, san: move.san, cp: -100 * (i + 1), mate: null, pv: [move.from + move.to] }));
  const analysis = await analyzeGame("unranked-drawing-escape", pgn, 3, evaluator);
  const last = analysis.moves.at(-1)!;
  expect(last.lines).toHaveLength(7);
  expect(last.bestMove).toBe(last.uci);
  expect(last.lines[0].uci).toBe(last.uci);
  expect(last.lines.map(line => line.cp)).toEqual([0, 100, 200, 300, 400, 500, 600]);
  expect(last.cpBefore).toBe(0);
  expect(last.cpl).toBe(0);
  expect(last.classification).toBe("best");
  const ranked = structuredClone(last.lines);
  capFallback(last.lines, false);
  expect(last.lines).toEqual(ranked);
  repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
  const once = structuredClone(analysis);
  repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
  expect(analysis).toEqual(once);
  expect(last.lines).toEqual(ranked);
});

test("repetition alternatives preserve White-POV mate scores for either mover through repair", async () => {
  for (const pgn of [
    "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2",
    '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"]\n\n1... Nf6 2. Nf3 Ng8 3. Ng1 Nf6 4. Nf3 Ng8 5. Ng1 1/2-1/2',
  ]) {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const playedByFen = new Map(chess.history({ verbose: true }).map(move => [move.before, move.from + move.to]));
    db.run("DELETE FROM position_evals");
    const evaluator = new Engine();
    evaluator.analyze = async (fen, _depth, searchMove) => new Chess(fen).moves({ verbose: true })
      .filter(move => !searchMove || move.from + move.to === searchMove)
      .sort((a, b) => Number(b.from + b.to === playedByFen.get(fen)) - Number(a.from + a.to === playedByFen.get(fen)))
      .slice(0, 6).map((move, i) => ({ uci: move.from + move.to, san: move.san, cp: i === 1 ? null : 600, mate: i === 1 ? 4 : null, pv: [move.from + move.to] }));
    const analysis = await analyzeGame("mating-repetition-alternative", pgn, 3, evaluator);
    const last = analysis.moves.at(-1)!;
    const sign = last.fenBefore.split(" ")[1] === "w" ? 1 : -1;
    expect(last.bestMove).not.toBe(last.uci);
    expect(last.lines[0]).toMatchObject({ cp: null, mate: 4 * sign });
    expect(last.cpBefore).toBe(1000 * sign);
    expect(last.mateBefore).toBe(4 * sign);
    expect(analysis.moves.at(-2)!.cpAfter).toBe(last.cpBefore);
    expect(analysis.moves.at(-2)!.mateAfter).toBe(last.mateBefore);
    expect(last.cpl).toBe(1000);
    expect(last.classification).toBe("blunder");
    const beforeRepair = structuredClone(analysis.moves);
    repairAnalysis(analysis, "me", { white_username: "me", black_username: "opp", pgn });
    expect(analysis.moves).toEqual(beforeRepair);
  }
});

test("a status restart during a real search preserves the replacement handshake for retry", async () => {
  const instance = new Engine();
  const state = instance as unknown as EngineState & { send: (command: string) => Promise<void> };
  const send = state.send.bind(instance);
  let searches = 0;
  let resolveGo: () => void = () => {};
  const go = new Promise<void>(resolve => { resolveGo = resolve; });
  state.send = async command => {
    await send(command);
    if (command.startsWith("go ") && ++searches === 1) resolveGo();
  };
  try {
    await instance.ensureStarted();
    const search = instance.analyze(new Chess().fen(), 5);
    await go;
    instance.kill();
    await instance.ensureStarted();
    expect(await search).toHaveLength(6);
    expect(searches).toBe(2);
  } finally { instance.kill(); }
}, 15000);

test("played-move fallback is capped at line six from either side's perspective", () => {
  for (const sign of [1, -1]) {
    const lines: EngineLine[] = [32, 25, 20, 15, 5, -10, 154].map(cp => ({ uci: "", san: "", cp: cp * sign, mate: null, pv: [] }));
    capFallback(lines, sign === 1);
    expect(lines[6].cp).toBe(-10 * sign);
    expect(lines[0].cp).toBe(32 * sign);
    const once = structuredClone(lines);
    capFallback(lines, sign === 1);
    expect(lines).toEqual(once);
    lines[6].cp = -100 * sign;
    capFallback(lines, sign === 1);
    expect(lines[6].cp).toBe(-100 * sign);
  }
});

test("accuracy uses win-percentage loss rather than centipawn loss", () => {
  expect(moveAccuracy(0, -28)).toBeGreaterThan(85);
  expect(moveAccuracy(0, -28)).toBeLessThan(95);
  expect(moveAccuracy(900, 872)).toBeGreaterThan(moveAccuracy(0, -28));
  expect(moveAccuracy(0, 0)).toBe(100);
  expect(moveAccuracy(0, 100)).toBe(100);
  expect(moveAccuracy(0, -3000)).toBeLessThan(15);
});

test("noisy MultiPV ranks cannot leave a capped fallback above engine line one", () => {
  const lines: EngineLine[] = [624, 617, 625, 626, 623, 632, 800].map(cp => ({ uci: "", san: "", cp, mate: null, pv: [] }));
  capFallback(lines, true);
  expect(lines[6].cp).toBe(617);
});

test("mate-ending game completes with the winning side and legal scored candidates", async () => {
  const pgn = "1. f3 e5 2. g4 Qh4# 0-1";
  const analysis = await analyzeGame("mate-regression", pgn, 4);
  expect(analysis.moves).toHaveLength(4);
  expect(analysis.moves.at(-1)?.mateAfter).toBe(0);
  expect(analysis.moves.at(-1)?.cpAfter).toBe(-1000);
  expect(analysis.moves.at(-1)?.cpl).toBe(0);
  for (const move of analysis.moves) {
    expect(move.lines.some(line => line.uci === move.uci)).toBe(true);
    for (const line of move.lines) {
      expect(() => new Chess(move.fenBefore).move(line.san)).not.toThrow();
    }
  }
  const decisions = buildDecisions(analysis, "me", { white_username: "me", pgn, time_control: "600" });
  expect(decisions).toHaveLength(2);
  expect(decisions.every(d => d.candidates.every(c => Object.values(c.features).every(Number.isFinite)))).toBe(true);
}, 30000);

test("terminal positions never require a search, including white delivering mate", async () => {
  const chess = new Chess();
  chess.loadPgn("1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#");
  expect(await analyzePosition(chess.fen())).toEqual({ lines: [], bestCpW: 1000, bestMateW: 0 });
  expect(await analyzePosition("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toEqual({ lines: [], bestCpW: 0, bestMateW: null });
});

test("simultaneous startup and searches share the handshake and recover after termination", async () => {
  const instance = new Engine();
  try {
    const fen = new Chess().fen();
    await Promise.all([instance.ensureStarted(), instance.ensureStarted()]);
    const results = await Promise.all([instance.analyze(fen, 3), instance.analyze(fen, 3, "e2e4")]);
    expect(results[0].length).toBe(6);
    expect(results[1].map(line => line.uci)).toEqual(["e2e4"]);
    instance.kill();
    expect((await instance.analyze(fen, 3)).length).toBe(6);
    const interrupted = instance.analyze(fen, 10);
    const crash = setTimeout(() => instance.kill(), 5);
    try { expect((await interrupted).length).toBe(6); }
    finally { clearTimeout(crash); }
  } finally { instance.kill(); }
}, 30000);

test("all published draw outcomes map to a draw", () => {
  for (const code of ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]) {
    expect(toGameResult(code)).toBe("draw");
  }
  expect(toGameResult("checkmated")).toBe("loss");
});

test("clock increments and missing clock tags do not fabricate time spent", () => {
  const clocks = [...moveClocks("1. e4 {[%clk 0:10:02]} e5 {[%clk 0:09:58]} 2. Nf3", "600+5").values()];
  expect(clocks).toEqual([{ left: 602, spent: 3 }, { left: 598, spent: 7 }, { left: null, spent: null }]);
});

test("feature extraction handles castling, promotion and en passant", () => {
  // Castling: the king shelters but the rook loses activity; a rook is developed.
  expect(features("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1")).toEqual({
    trades: 0, queensOff: 1, centerLock: 0, openFiles: 8, aggression: 0, pawnStorm: 0,
    kingSafety: -1, materialRisk: 0, activity: -2, restriction: 3, complexity: 0,
    endgame: 1, development: 1, centerControl: 0,
  });
  // Promotion: a queen is a large activity gain and a forcing move.
  expect(features("7k/P7/8/8/8/8/8/7K w - - 0 1", "a7a8q")).toEqual({
    trades: 0, queensOff: 0, centerLock: 0, openFiles: 8, aggression: 1, pawnStorm: 0,
    kingSafety: 0, materialRisk: 0, activity: 16, restriction: 1, complexity: 0,
    endgame: 1, development: 0, centerControl: 2,
  });
  // En passant: the captured pawn opens the d-file to seven open files.
  expect(features("7k/8/8/3pP3/8/8/8/7K w - d6 0 1", "e5d6")).toEqual({
    trades: 0, queensOff: 1, centerLock: 0, openFiles: 7, aggression: 1, pawnStorm: 0,
    kingSafety: 0, materialRisk: 0, activity: -1, restriction: 1, complexity: 0,
    endgame: 1, development: 0, centerControl: 0,
  });
});

test("a central opening push is not a pawn storm against an uncastled king", () => {
  expect(features(new Chess().fen(), "e2e4").pawnStorm).toBe(0);
  expect(features("5rk1/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1", "h2h4").pawnStorm).toBe(2);
});
