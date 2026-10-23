import { Chess } from "chess.js";
import os from "node:os";
import type { Decision, EngineLine, GameAnalysis, MoveAnalysis, StyleCandidate } from "@chess/shared";

type Classification = MoveAnalysis["classification"];
import { db, getGame, SUMMARY_VERSION, type GameRow } from "./db";
import { Engine, engine, engineMeta, mateFromWhitePov, cpFromWhitePov } from "./engine";
import { features, moveClocks } from "./features";
import { scheduleStyleTraining } from "./style";

export const ANALYSIS_DEPTH = Number(process.env.ANALYSIS_DEPTH ?? 14);
if (!Number.isInteger(ANALYSIS_DEPTH) || ANALYSIS_DEPTH < 1 || ANALYSIS_DEPTH > 30) {
  throw new Error("ANALYSIS_DEPTH must be an integer from 1 to 30");
}
const MAX_CPL = 1000;
const ACCURACY_CP_LIMIT = 3000;
const ACCURACY_WIN_CURVE = 0.002;
/** Bump when cached evaluations or saved analyses must not be reused as-is. */
export const ANALYSIS_REVISION = 2;

/** Clamp a centipawn value to the mate-equivalent range before measuring loss. */
function clampCp(cp: number): number {
  return Math.max(-MAX_CPL, Math.min(MAX_CPL, cp));
}

interface PlyData {
  ply: number;
  san: string;
  fenBefore: string;
  fenAfter: string;
  uci: string;
  moverIsWhite: boolean;
  drawAfter: boolean;
}

function buildPlies(pgn: string): PlyData[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  // Replaying preserves repetition counts, which a board constructed from FEN loses.
  if (history.length) chess.load(history[0].before);
  const plies: PlyData[] = [];
  for (const move of history) {
    chess.move(move.san);
    const fenBefore = move.before;
    const fenAfter = move.after;
    plies.push({
      ply: plies.length + 1,
      san: move.san,
      fenBefore,
      fenAfter,
      uci: move.from + move.to + (move.promotion ?? ""),
      moverIsWhite: move.color === "w",
      // Chess.com ends games on repetition, so a mid-game flag is a position-key disagreement.
      drawAfter: plies.length === history.length - 1 && chess.isThreefoldRepetition(),
    });
  }
  return plies;
}

function bestCpFromWhitePov(lines: EngineLine[], sideToMoveIsWhite: boolean): number | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  if (first.cp !== null) return cpFromWhitePov(first, sideToMoveIsWhite);
  if (first.mate !== null) {
    const m = mateFromWhitePov(first, sideToMoveIsWhite);
    return m === null ? null : m > 0 ? MAX_CPL : -MAX_CPL;
  }
  return null;
}

function bestMateFromWhitePov(lines: EngineLine[], sideToMoveIsWhite: boolean): number | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  if (first.mate === null) return null;
  return mateFromWhitePov(first, sideToMoveIsWhite);
}

interface PositionEval {
  lines: EngineLine[];
  bestCpW: number | null;
  bestMateW: number | null;
}

export async function analyzePosition(fen: string, depth = ANALYSIS_DEPTH, searchMove?: string, evaluator = engine): Promise<PositionEval> {
  const sideToMoveIsWhite = fen.split(" ")[1] === "w";
  const chess = new Chess(fen);
  // Mate zero has no sign. The side to move has lost; retain winner in cp.
  if (chess.isCheckmate()) return { lines: [], bestCpW: sideToMoveIsWhite ? -MAX_CPL : MAX_CPL, bestMateW: 0 };
  if (chess.isDraw()) return { lines: [], bestCpW: 0, bestMateW: null };
  const key = `${engineMeta.version}:${ANALYSIS_REVISION}:6:${depth}:${fen}:${searchMove ?? ""}`;
  const cached = db.query<{ data: string }, [string]>("SELECT data FROM position_evals WHERE cache_key = ?").get(key);
  if (cached) return JSON.parse(cached.data) as PositionEval;
  const rawLines = await evaluator.analyze(fen, depth, searchMove);
  // engine.analyze returns MultiPV rank order with scores in side-to-move POV.
  // Store contract: cp/mate in White's POV.
  const lines = rawLines.map((l) => ({
    uci: l.uci,
    san: sanForUci(fen, l.uci),
    cp: cpFromWhitePov(l, sideToMoveIsWhite),
    mate: mateFromWhitePov(l, sideToMoveIsWhite),
    pv: l.pv,
  }));
  const result = {
    lines,
    bestCpW: bestCpFromWhitePov(rawLines, sideToMoveIsWhite),
    bestMateW: bestMateFromWhitePov(rawLines, sideToMoveIsWhite),
  };
  db.run("INSERT OR REPLACE INTO position_evals VALUES (?, ?)", [key, JSON.stringify(result)]);
  return result;
}

/** Win probability in percent for a centipawn score, from the side to move's view. */
export function winPercent(cp: number): number {
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}

/**
 * Classify by win-probability loss rather than raw centipawns, so a move that
 * gives up material while already winning does not read as a blunder.
 * `before` is the pre-move score from the mover's perspective.
 */
export function classify(cpl: number | null, isTopMove: boolean, before: number): Classification {
  if (cpl === null || isTopMove) return "best";
  const loss = Math.max(0, winPercent(before) - winPercent(before - cpl));
  if (loss < 2) return "excellent";
  if (loss < 5) return "good";
  if (loss < 10) return "inaccuracy";
  if (loss < 20) return "mistake";
  return "blunder";
}

/** Per-move accuracy on the flatter accuracy curve; scores are mover-POV and already in accuracy range. */
export function moveAccuracy(beforeCp: number, afterCp: number): number {
  const win = (cp: number) => 100 / (1 + Math.exp(-ACCURACY_WIN_CURVE * cp));
  const loss = Math.max(0, win(beforeCp) - win(afterCp));
  if (loss === 0) return 100;
  const acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.min(100, Math.max(0, acc));
}

function emptyCounts(): Record<Classification, number> {
  return { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0 };
}

function sanForUci(fen: string, uci: string): string {
  try {
    const c = new Chess(fen);
    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

function lineValueW(line: EngineLine): number {
  if (line.cp !== null) return line.cp;
  if (line.mate !== null) return line.mate > 0 ? MAX_CPL : -MAX_CPL;
  return 0;
}

/** An unranked move stays below all root candidates, including noisy cross-depth ranks. */
export function capFallback(lines: EngineLine[], whiteToMove: boolean, multiPv = 6): void {
  if (!lines[multiPv - 1]) return;
  const sign = whiteToMove ? 1 : -1;
  // Normally line six is weakest. Taking the minimum also covers rank/score inversions.
  const ceiling = lines.slice(0, multiPv).reduce((worst, line) => lineValueW(line) * sign < lineValueW(worst) * sign ? line : worst);
  for (const line of lines.slice(multiPv)) {
    if (lineValueW(line) * sign > lineValueW(ceiling) * sign) {
      line.cp = ceiling.cp;
      line.mate = ceiling.mate;
    }
  }
}

/** Score a known draw after fallback capping, so a losing root score cannot hide it. */
function scoreDraw(lines: EngineLine[], uci: string, san: string): void {
  const played = lines.find(line => line.uci === uci);
  if (played) {
    played.cp = 0;
    played.mate = null;
  } else {
    lines.push({ uci, san, cp: 0, mate: null, pv: [uci] });
  }
}

/** Re-rank a final repetition after scoring the draw; both plies share this position. */
function rankRepetition(move: MoveAnalysis, previous: MoveAnalysis | undefined): void {
  const sign = move.fenBefore.split(" ")[1] === "w" ? 1 : -1;
  // Value order keeps trailing candidates below the fallback ceiling on later repairs.
  move.lines.sort((a, b) => (lineValueW(b) - lineValueW(a)) * sign);
  const best = move.lines[0];
  move.bestMove = best.uci;
  move.bestMoveSan = best.san;
  move.cpBefore = best.cp ?? (best.mate === null ? null : lineValueW(best));
  move.mateBefore = best.mate;
  if (previous) {
    previous.cpAfter = move.cpBefore;
    previous.mateAfter = move.mateBefore;
  }
}

/** Fresh analysis and repair use the same caps, mover perspective and verdict. */
function moveLoss(move: Pick<MoveAnalysis, "fenBefore" | "cpBefore" | "cpAfter" | "uci" | "lines">): Pick<MoveAnalysis, "cpl" | "classification"> {
  const sign = move.fenBefore.split(" ")[1] === "w" ? 1 : -1;
  const before = move.cpBefore === null ? null : clampCp(move.cpBefore * sign);
  const played = move.lines.find(line => line.uci === move.uci);
  const after = played ? lineValueW(played) : move.cpAfter;
  const cpl = before === null || after === null ? null : Math.max(0, before - clampCp(after * sign));
  const isTop = move.uci === move.lines[0]?.uci;
  return { cpl, classification: classify(cpl, isTop, before ?? 0) };
}

/** Idempotent repair also used when migrating existing analyses without engine searches. */
export function repairAnalysis(analysis: GameAnalysis, username: string, game: { white_username: string | null; black_username: string | null; pgn: string }): void {
  const plies = buildPlies(game.pgn);
  for (const [i, move] of analysis.moves.entries()) {
    const white = move.fenBefore.split(" ")[1] === "w";
    capFallback(move.lines, white, analysis.engine.multiPv);
    const drawAfter = plies[i]?.drawAfter ?? false;
    if (drawAfter) {
      move.cpAfter = 0;
      move.mateAfter = null;
      scoreDraw(move.lines, move.uci, move.san);
      rankRepetition(move, analysis.moves[i - 1]);
    }
    Object.assign(move, moveLoss(move));
  }
  analysis.summary = computeSummary(analysis, username, game);
}

export async function analyzeGame(gameUuid: string, pgn: string, depth = ANALYSIS_DEPTH, evaluator = engine): Promise<GameAnalysis> {
  const plies = buildPlies(pgn);

  // evals[i] is the position before ply i; evals[N] is the final position.
  const evals: PositionEval[] = [];
  for (const ply of plies) {
    evals.push(await analyzePosition(ply.fenBefore, depth, undefined, evaluator));
  }
  const last = plies.at(-1);
  evals.push(last?.drawAfter
    ? { lines: [], bestCpW: 0, bestMateW: null }
    : await analyzePosition(last?.fenAfter ?? new Chess().fen(), depth, undefined, evaluator));

  const moves: MoveAnalysis[] = [];
  for (let i = 0; i < plies.length; i++) {
    const ply = plies[i];
    // Game-specific played scores must never mutate a position-only cache value.
    const before = { ...evals[i], lines: evals[i].lines.map(line => ({ ...line })) };
    const after = evals[i + 1];

    if (!ply.drawAfter && before.lines.length && !before.lines.some(line => line.uci === ply.uci)) {
      const played = await analyzePosition(ply.fenBefore, depth, ply.uci, evaluator);
      before.lines.push(...played.lines.map(line => ({ ...line })));
    }
    capFallback(before.lines, ply.moverIsWhite);
    if (ply.drawAfter) scoreDraw(before.lines, ply.uci, ply.san);

    const bestBefore = before.bestCpW;
    const bestAfter = after.bestCpW;

    const bestLine = before.lines[0] ?? null;
    const topMove = bestLine?.uci ?? "";

    const move: MoveAnalysis = {
      ply: ply.ply,
      san: ply.san,
      fenBefore: ply.fenBefore,
      fenAfter: ply.fenAfter,
      uci: ply.uci,
      cpBefore: bestBefore,
      cpAfter: bestAfter,
      mateBefore: before.bestMateW,
      mateAfter: after.bestMateW,
      cpl: null,
      classification: "best",
      bestMove: topMove || undefined,
      bestMoveSan: topMove ? sanForUci(ply.fenBefore, topMove) : undefined,
      lines: before.lines,
    };
    if (ply.drawAfter) rankRepetition(move, moves.at(-1));
    Object.assign(move, moveLoss(move));
    moves.push(move);
  }

  return {
    gameUuid,
    engine: { name: engineMeta.name, version: engineMeta.version, depth, multiPv: 6, revision: ANALYSIS_REVISION },
    moves,
    summary: { myAccuracy: 0, myCpl: 0, opponentAccuracy: 0, counts: emptyCounts() },
  };
}

/** Accuracy uses its own cp range; mate zero keeps the winner encoded in cp. */
function accuracyCp(cp: number, mate: number | null): number {
  if (mate !== null) return Math.sign(mate === 0 ? cp : mate) * ACCURACY_CP_LIMIT;
  return Math.max(-ACCURACY_CP_LIMIT, Math.min(ACCURACY_CP_LIMIT, cp));
}

/**
 * Chess.com calibration on 44 games, with nested game-level LOO selecting the
 * 0.002 win curve, position-to-position loss and +/-3000 cp/mate range.
 * Rescale the mean with slope 2.332013, offset -135.485518 and length -4,
 * relative to 30 scored moves, capped at +/-4*ln(3). Outer MAE: 2.98 points.
 * These four calibration constants estimate CAPS2; classifications keep their own curve.
 */
function sideAccuracy(moves: MoveAnalysis[], sideIsWhite: boolean): number {
  let count = 0;
  let sum = 0;
  for (const move of moves) {
    const moverIsWhite = move.fenBefore.split(" ")[1] === "w";
    if (moverIsWhite !== sideIsWhite || move.cpBefore === null || move.cpAfter === null || move.cpl === null) continue;
    const sign = moverIsWhite ? 1 : -1;
    const before = accuracyCp(move.cpBefore, move.mateBefore) * sign;
    const after = accuracyCp(move.cpAfter, move.mateAfter) * sign;
    sum += moveAccuracy(before, after);
    count++;
  }
  if (!count) return 0;
  const length = Math.max(-Math.log(3), Math.min(Math.log(3), Math.log(count / 30)));
  return Math.max(0, Math.min(100, 2.332013 * sum / count - 135.485518 - 4 * length));
}

export function computeSummary(
  analysis: GameAnalysis,
  username: string,
  game: { white_username: string | null; black_username: string | null }
): GameAnalysis["summary"] {
  const myColor = game.white_username?.toLowerCase() === username.toLowerCase() ? "w" : "b";
  const counts = emptyCounts();
  const myCpls: number[] = [];

  for (const m of analysis.moves) {
    const moverIsWhite = m.fenBefore.split(" ")[1] === "w";
    if (moverIsWhite === (myColor === "w")) {
      counts[m.classification] += 1;
      if (m.cpl !== null) myCpls.push(m.cpl);
    }
  }

  const avgCpl = myCpls.length > 0 ? myCpls.reduce((a, b) => a + b, 0) / myCpls.length : 0;
  return {
    myAccuracy: sideAccuracy(analysis.moves, myColor === "w"),
    myCpl: avgCpl,
    opponentAccuracy: sideAccuracy(analysis.moves, myColor === "b"),
    counts,
  };
}

/** Columns that mirror the owner's summary for list/profile reads. */
export function summaryColumns(summary: GameAnalysis["summary"]): Record<string, string | number> {
  return {
    my_accuracy: summary.myAccuracy,
    my_cpl: summary.myCpl,
    my_counts: JSON.stringify(summary.counts),
    summary_version: SUMMARY_VERSION,
  };
}

function now(): number {
  return Date.now();
}

function setAnalysisRow(uuid: string, fields: Record<string, string | number | null>): void {
  db.run(
    `INSERT INTO analyses (game_uuid, status, updated_at) VALUES (?, 'pending', ?)
     ON CONFLICT(game_uuid) DO NOTHING`,
    [uuid, now()]
  );
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values: (string | number | null)[] = [...Object.values(fields), now(), uuid];
  db.run(`UPDATE analyses SET ${sets}, updated_at = ? WHERE game_uuid = ?`, values);
}

export function queueAnalysis(username: string, gameUuids: string[]): number {
  let queued = 0;
  for (const uuid of gameUuids) {
    const game = db.query("SELECT * FROM games WHERE uuid = ?").get(uuid) as
      | { uuid: string; white_username: string | null; black_username: string | null; pgn: string }
      | null;
    if (!game || ![game.white_username, game.black_username].some(name => name?.toLowerCase() === username.toLowerCase())) continue;
    const result = db.run(
      `INSERT INTO analyses (game_uuid, username, status, updated_at) VALUES (?, ?, 'pending', ?)
       ON CONFLICT(game_uuid) DO UPDATE SET username = excluded.username, status = 'pending', error = NULL, updated_at = excluded.updated_at
       WHERE analyses.status NOT IN ('done', 'pending', 'running') OR analyses.username IS NULL`,
      [uuid, username.toLowerCase(), now()]
    );
    queued += result.changes;
  }
  pump();
  return queued;
}

/** Drop or restore queued analyses: a row with saved data becomes done again, otherwise it disappears. */
export function cancelPendingAnalyses(username: string): number {
  const rows = db.query<{ game_uuid: string; has_data: number }, [string]>(
    "SELECT game_uuid, data IS NOT NULL AS has_data FROM analyses WHERE username = ? COLLATE NOCASE AND status = 'pending'"
  ).all(username);
  for (const row of rows) {
    if (row.has_data) db.run("UPDATE analyses SET status = 'done' WHERE game_uuid = ?", [row.game_uuid]);
    else db.run("DELETE FROM analyses WHERE game_uuid = ?", [row.game_uuid]);
  }
  return rows.length;
}

interface QueueItem {
  uuid: string;
  username: string;
}

/**
 * Analysis worker processes: the ANALYSIS_WORKERS value when it parses, else a
 * quarter of the logical cores, both clamped to 1-4.
 */
export function resolveWorkerCount(envValue: string | undefined, cores: number): number {
  const fallback = Math.floor(cores / 4);
  const requested = Math.floor(Number(envValue));
  const chosen = envValue === undefined || envValue.trim() === "" || !Number.isFinite(requested) ? fallback : requested;
  return Math.max(1, Math.min(4, chosen));
}

export const workerCount = resolveWorkerCount(process.env.ANALYSIS_WORKERS, os.availableParallelism());
const evaluators = [engine, ...Array.from({ length: workerCount - 1 }, () => new Engine())];
const busy = new Set<Engine>();

/** Replaceable in tests so finishing the queue can be exercised without spawning a trainer. */
let trainingScheduler: (username: string) => void = scheduleStyleTraining;

export function setTrainingScheduler(scheduler?: (username: string) => void): void {
  trainingScheduler = scheduler ?? scheduleStyleTraining;
}

const TRAINING_IDLE_DELAY_MS = 250;

/** Retrain once the queue drains; skipped while any analysis is still pending. */
export function scheduleTrainingIfIdle(username: string): void {
  if (db.query("SELECT 1 FROM analyses WHERE status = 'pending' AND username IS NOT NULL LIMIT 1").get()) return;
  // Defer the spawn a little so a burst of completions or a shutdown cannot race the child launch.
  const scheduler = trainingScheduler;
  setTimeout(() => {
    if (db.query("SELECT 1 FROM analyses WHERE status = 'pending' AND username IS NOT NULL LIMIT 1").get()) return;
    scheduler(username);
  }, TRAINING_IDLE_DELAY_MS);
}

export function pump(): void {
  for (const evaluator of evaluators) {
    if (busy.has(evaluator)) continue;
    const item = db.query<QueueItem, []>(`SELECT game_uuid AS uuid, username FROM analyses
      WHERE status = 'pending' AND username IS NOT NULL ORDER BY updated_at, game_uuid LIMIT 1`).get();
    if (!item) return;
    busy.add(evaluator);
    void processItem(item, evaluator).finally(() => {
      busy.delete(evaluator);
      scheduleTrainingIfIdle(item.username);
      pump();
    });
  }
}

async function processItem(item: QueueItem, evaluator: Engine): Promise<void> {
  const game = getGame(item.uuid);
  if (!game) {
    setAnalysisRow(item.uuid, { status: "error", error: "Game no longer exists" });
    return;
  }

  setAnalysisRow(item.uuid, { status: "running" });
  const started = performance.now();
  try {
    const analysis = await analyzeGame(item.uuid, game.pgn, ANALYSIS_DEPTH, evaluator);
    saveGameAnalysis({ game, username: item.username, analysis, source: "completion" });
    console.log(`analysis done: ${item.uuid} (${analysis.moves.length} plies, ${Math.round((performance.now() - started) / 1000)} seconds)`);
  } catch (err) {
    setAnalysisRow(item.uuid, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`analysis failed: ${item.uuid}`, err);
  }
}

/** Mean cpl of the same player's moves in the next ten plies, or null when there are none. */
export function nextTenPlyCpl(moves: MoveAnalysis[], ply: number, moverIsWhite: boolean): number | null {
  const following = moves.filter(next => next.ply > ply && next.ply <= ply + 10 &&
    (next.fenBefore.split(" ")[1] === "w") === moverIsWhite && next.cpl !== null);
  return following.length ? following.reduce((sum, next) => sum + next.cpl!, 0) / following.length : null;
}

export function buildDecisions(
  analysis: GameAnalysis, username: string,
  game: { white_username: string | null; pgn: string; time_control: string; end_time?: number }
): Decision[] {
  const myWhite = game.white_username?.toLowerCase() === username.toLowerCase();
  const clocks = moveClocks(game.pgn, game.time_control ?? "");
  return analysis.moves.filter(move => (move.fenBefore.split(" ")[1] === "w") === myWhite).map(move => {
    const sign = myWhite ? 1 : -1;
    const finite = move.lines.filter(line => line.cp !== null).map(line => line.cp! * sign);
    const spread = finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
    const candidates: StyleCandidate[] = move.lines.map(line => ({
      ...line, value: lineValueW(line) * sign, features: features(move.fenBefore, line.uci, line.pv, spread),
    }));
    const clock = clocks.get(move.fenAfter);
    const materialBefore = new Chess(move.fenBefore).board().flat().reduce((sum, piece) =>
      sum + (piece ? ({ p: 0, n: 3, b: 3, r: 5, q: 9, k: 0 }[piece.type]) : 0), 0);
    return {
      gameUuid: analysis.gameUuid, ply: move.ply, fen: move.fenBefore, played: move.uci, candidates,
      playedAt: game.end_time ?? 0,
      clockLeft: clock?.left ?? null, timeSpent: clock?.spent ?? null,
      phase: materialBefore <= 20 ? "endgame" : move.ply <= 20 ? "opening" : "middlegame",
      nextTenPlyCpl: nextTenPlyCpl(analysis.moves, move.ply, myWhite),
    };
  });
}

/** Where a saved analysis came from; each source keeps its own metadata. */
export type AnalysisSaveSource = "completion" | "startup-repair" | "feature-refresh";

/**
 * Derive the summary and decisions, then atomically replace the saved analysis,
 * summary columns and decisions while explicitly staling the stored profile.
 * Completion derives a fresh summary; saved-data sources repair saved scores
 * first. Only the selected player's decisions for this game are replaced and
 * only an existing row for that player is staled, keeping its profile data.
 */
export function saveGameAnalysis({ game, username, analysis, source }: {
  game: GameRow;
  username: string;
  analysis: GameAnalysis;
  source: AnalysisSaveSource;
}) {
  if (source === "completion") {
    analysis.summary = computeSummary(analysis, username, game);
  } else {
    repairAnalysis(analysis, username, game);
  }
  const decisions = buildDecisions(analysis, username, game);
  const data = JSON.stringify(analysis);
  const columns = summaryColumns(analysis.summary);
  const stale = source === "startup-repair" ? "stale:summary-migration" : `stale:${source}`;
  const updated = now();
  db.transaction(() => {
    // Replace, do not merge: a redone game must not keep stale decisions.
    db.run("DELETE FROM decisions WHERE username = ? AND game_uuid = ?", [username, game.uuid]);
    for (const decision of decisions) {
      db.run(`INSERT INTO decisions VALUES (?, ?, ?, ?) ON CONFLICT(username, game_uuid, ply)
        DO UPDATE SET data = excluded.data`, [username, game.uuid, decision.ply, JSON.stringify(decision)]);
    }
    if (source === "completion") {
      db.run(`INSERT INTO analyses (game_uuid, username, status, updated_at) VALUES (?, ?, 'pending', ?)
        ON CONFLICT(game_uuid) DO NOTHING`, [game.uuid, username, updated]);
      db.run(`UPDATE analyses SET username = ?, status = 'done', engine_name = ?, engine_version = ?, depth = ?,
        multi_pv = ?, data = ?, error = NULL, my_accuracy = ?, my_cpl = ?, my_counts = ?,
        summary_version = ?, updated_at = ? WHERE game_uuid = ?`,
      [username, engineMeta.name, engineMeta.version, ANALYSIS_DEPTH, 6, data,
        columns.my_accuracy, columns.my_cpl, columns.my_counts, columns.summary_version, updated, game.uuid]);
      db.run("UPDATE games SET analyzed = 1 WHERE uuid = ?", [game.uuid]);
    } else if (source === "feature-refresh") {
      db.run("UPDATE analyses SET data = ?, my_accuracy = ?, my_cpl = ?, my_counts = ?, summary_version = ?, updated_at = ? WHERE game_uuid = ?",
        [data, columns.my_accuracy, columns.my_cpl, columns.my_counts, columns.summary_version, updated, game.uuid]);
    } else {
      db.run("UPDATE analyses SET data = ?, my_accuracy = ?, my_cpl = ?, my_counts = ?, summary_version = ? WHERE game_uuid = ?",
        [data, columns.my_accuracy, columns.my_cpl, columns.my_counts, columns.summary_version, game.uuid]);
    }
    // The aggregate signature alone would not change when rewritten decisions
    // keep the same count and timestamps, so stale the row explicitly.
    db.run("UPDATE style_profiles SET signature = ? WHERE username = ? COLLATE NOCASE", [stale, username]);
  })();
  return decisions.length;
}

/**
 * Repair summaries and rebuild decisions without an engine run. Preserve analysis
 * timestamps and explicitly invalidate stored profiles whose decisions are rewritten.
 */
export function migrateSummaries(): number {
  const rows = db.query<{ game_uuid: string; username: string; data: string | null }, [number]>(
    `SELECT game_uuid, username, data FROM analyses
     WHERE status = 'done' AND username IS NOT NULL AND summary_version < ?`
  ).all(SUMMARY_VERSION);
  if (rows.length) console.log(`summary migration: repairing ${rows.length} analyses without the engine; this runs once`);
  let migrated = 0;
  // Each row runs in its own savepoint so one corrupt row rolls back alone;
  // no outer transaction, so the migration never holds the write lock longer
  // than a single row.
  for (const row of rows) {
    // One corrupt row must not stop the migration or the server boot. Each
    // row runs in its own savepoint, so a failure after a partial write rolls
    // that row back while the other rows still migrate.
    try {
      db.transaction(() => {
        const game = getGame(row.game_uuid);
        if (!row.data || !game) {
          db.run("UPDATE analyses SET summary_version = ? WHERE game_uuid = ?", [SUMMARY_VERSION, row.game_uuid]);
          return;
        }
        const analysis = JSON.parse(row.data) as GameAnalysis;
        saveGameAnalysis({ game, username: row.username, analysis, source: "startup-repair" });
        migrated += 1;
      })();
    } catch (err) {
      console.error(`summary migration skipped ${row.game_uuid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`summary migration: ${migrated} rows migrated to v${SUMMARY_VERSION}`);
  return migrated;
}

export function shutdownEngine(): void {
  for (const evaluator of evaluators) evaluator.kill();
}
