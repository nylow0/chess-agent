import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chess } from "chess.js";
import path from "node:path";
import type {
  GameAnalysis,
  GameDetail,
  GameSummary,
  EngineStatus,
  ProfileStats,
  PlayerSummary,
} from "@chess/shared";
import { getAnalysis, getGame, getGamesForUser, getQueueCounts, type AnalysisRow, type GameRow } from "./db";
import { cleanOpeningName, fetchPlayer, NotFoundError, syncGames } from "./chesscom";
import { engine, engineMeta } from "./engine";
import { cancelPendingAnalyses, computeSummary, queueAnalysis } from "./worker";
import { getDecision, readStyleProfile, recommend, storedProfile } from "./style";
import { serveWebApp } from "./static";

class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const app = new Hono();

app.use("*", cors({ origin: "*" }));

app.onError((err, c) => {
  if (err instanceof ApiFailure) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "internal server error" }, 500);
});

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiFailure(400, `missing or invalid field: ${name}`);
  }
  return value.trim();
}

app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const username = requireString((body as Record<string, unknown> | null)?.username, "username");
  try {
    const player = await fetchPlayer(username);
    return c.json({
      username: player.username ?? username,
      ...(player.avatar ? { avatar: player.avatar } : {}),
      ...(player.url ? { url: player.url } : {}),
      ...(player.joined !== undefined ? { joined: player.joined } : {}),
      ...(player.followers !== undefined ? { followers: player.followers } : {}),
    });
  } catch (err) {
    if (err instanceof NotFoundError) throw new ApiFailure(404, `player "${username}" not found on chess.com`);
    throw err;
  }
});

app.post("/api/sync", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const username = requireString((body as Record<string, unknown> | null)?.username, "username");
  try {
    const result = await syncGames(username, body?.allHistory === true);
    return c.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ApiFailure(404, `player "${username}" not found on chess.com`);
    throw err;
  }
});

function toPlayerSummary(
  username: string | null,
  rating: number,
  result: string
): PlayerSummary {
  return {
    username: username ?? "?",
    rating,
    result: result === "win" ? "win" : result === "draw" ? "draw" : "loss",
  };
}

type MyStats = Pick<GameSummary, "myAccuracy" | "myCpl" | "myCounts">;

/** Decode the owner's mirrored summary columns. */
function decodeMyStats(
  status: string | null,
  myAccuracy: number | null,
  myCpl: number | null,
  myCounts: string | null
): MyStats {
  if (status !== "done") return {};
  const stats: MyStats = {};
  if (myAccuracy !== null) stats.myAccuracy = myAccuracy;
  if (myCpl !== null) stats.myCpl = myCpl;
  if (myCounts) {
    try {
      const counts = JSON.parse(myCounts) as Record<string, number>;
      stats.myCounts = {
        inaccuracy: counts.inaccuracy ?? 0,
        mistake: counts.mistake ?? 0,
        blunder: counts.blunder ?? 0,
      };
    } catch {
      /* leave counts unset for a malformed cache */
    }
  }
  return stats;
}

/** Only the analysis owner can use its mirrored columns; derive another viewer's side. */
function viewerStats(
  game: GameRow,
  row: Pick<AnalysisRow, "username" | "my_accuracy" | "my_cpl" | "my_counts"> & { status: string | null },
  username?: string
): MyStats {
  if (row.status !== "done") return {};
  if (username !== undefined && row.username?.toLowerCase() !== username.toLowerCase()) {
    const data = getAnalysis(game.uuid)?.data;
    if (!data) return {};
    const summary = computeSummary(JSON.parse(data) as GameAnalysis, username, game);
    return { myAccuracy: summary.myAccuracy, myCpl: summary.myCpl,
      myCounts: { inaccuracy: summary.counts.inaccuracy, mistake: summary.counts.mistake, blunder: summary.counts.blunder } };
  }
  return decodeMyStats(row.status, row.my_accuracy, row.my_cpl, row.my_counts);
}

app.get("/api/games", (c) => {
  const username = requireString(c.req.query("username"), "username");
  const rows = getGamesForUser(username);
  const summaries: GameSummary[] = rows.map((row) => ({
    uuid: row.uuid,
    chessComId: row.uuid,
    timeControl: row.time_control ?? "",
    timeClass: (row.time_class ?? "blitz") as GameSummary["timeClass"],
    rated: row.rated === 1,
    playedAt: row.end_time,
    white: toPlayerSummary(row.white_username, row.white_rating, row.white_result),
    black: toPlayerSummary(row.black_username, row.black_rating, row.black_result),
    opening: cleanOpeningName(row.opening) ?? undefined,
    analyzed: row.analysis_status === "done",
    analysisStatus: (row.analysis_status as GameSummary["analysisStatus"]) ?? undefined,
    url: row.url ?? undefined,
    ...viewerStats(row, { ...row, status: row.analysis_status, username: row.analysis_username }, username),
  }));
  return c.json(summaries);
});

app.get("/api/games/:uuid", (c) => {
  const uuid = c.req.param("uuid");
  const viewer = c.req.query("username");
  const username = viewer === undefined ? undefined : requireString(viewer, "username");
  const row = getGame(uuid);
  if (!row) throw new ApiFailure(404, `game ${uuid} not found`);
  const chess = new Chess();
  try {
    if (!row.pgn) throw new Error("missing PGN");
    chess.loadPgn(row.pgn);
  } catch {
    throw new ApiFailure(422, `game ${uuid} has no usable PGN`);
  }
  const moves: string[] = [];
  const fens: string[] = [];
  for (const move of chess.history({ verbose: true })) {
    fens.push(move.before);
    moves.push(move.san);
  }
  fens.push(chess.fen());
  const analysisRow = getAnalysis(uuid);
  const detail: GameDetail = {
    uuid: row.uuid,
    chessComId: row.uuid,
    timeControl: row.time_control ?? "",
    timeClass: (row.time_class ?? "blitz") as GameSummary["timeClass"],
    rated: row.rated === 1,
    playedAt: row.end_time,
    white: toPlayerSummary(row.white_username, row.white_rating, row.white_result),
    black: toPlayerSummary(row.black_username, row.black_rating, row.black_result),
    opening: cleanOpeningName(row.opening) ?? undefined,
    analyzed: analysisRow?.status === "done",
    url: row.url ?? undefined,
    pgn: row.pgn,
    moves,
    fens,
    ...(analysisRow
      ? viewerStats(row, analysisRow, username)
      : {}),
  };
  return c.json(detail);
});

app.post("/api/analyze", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const username = requireString((body as Record<string, unknown> | null)?.username, "username");
  const gameUuids = (body as Record<string, unknown>)?.gameUuids;
  if (!Array.isArray(gameUuids) || !gameUuids.every((u) => typeof u === "string")) {
    throw new ApiFailure(400, "gameUuids must be an array of strings");
  }
  const queued = queueAnalysis(username, gameUuids as string[]);
  return c.json({ queued });
});

app.post("/api/analyze/cancel", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const username = requireString((body as Record<string, unknown> | null)?.username, "username");
  return c.json({ cancelled: cancelPendingAnalyses(username) });
});

app.get("/api/analysis/:uuid", (c) => {
  const uuid = c.req.param("uuid");
  const viewer = c.req.query("username");
  const username = viewer === undefined ? undefined : requireString(viewer, "username");
  const row = getAnalysis(uuid);
  if (!row) {
    // A known game that has never been analysed is a normal state, not a 404.
    if (!getGame(uuid)) throw new ApiFailure(404, `game ${uuid} not found`);
    return c.json({ status: "unanalyzed" });
  }
  if (row.status === "done" && row.data) {
    const analysis = JSON.parse(row.data) as GameAnalysis;
    if (username !== undefined) {
      const game = getGame(uuid);
      if (game) analysis.summary = computeSummary(analysis, username, game);
    }
    return c.json({ status: "done", analysis });
  }
  if (row.status === "error") {
    return c.json({ status: "error", error: row.error ?? "unknown error" });
  }
  return c.json({ status: row.status });
});

app.get("/api/engine", async (c) => {
  try {
    await engine.ensureStarted();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  const status: EngineStatus = {
    name: engineMeta.name,
    version: engineMeta.version,
    ready: engine.isReady,
  };
  return c.json(status);
});

app.get("/api/profile/:username", (c) => {
  const username = requireString(c.req.param("username"), "username");
  const rows = getGamesForUser(username);
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let analyzedGames = 0;
  const accs: number[] = [];
  const cpls: number[] = [];
  for (const row of rows) {
    const mine = row.white_username?.toLowerCase() === username.toLowerCase() ? row.white_result : row.black_result;
    if (mine === "win") wins += 1;
    else if (mine === "draw") draws += 1;
    else losses += 1;
    if (row.analysis_status !== "done") continue;
    analyzedGames += 1;
    const summary = viewerStats(row, { ...row, status: row.analysis_status, username: row.analysis_username }, username);
    if (summary.myAccuracy !== undefined) accs.push(summary.myAccuracy);
    if (summary.myCpl !== undefined) cpls.push(summary.myCpl);
  }

  const stats: ProfileStats = {
    username,
    games: rows.length,
    analyzedGames,
    wins,
    draws,
    losses,
    winRate: rows.length > 0 ? wins / rows.length : null,
    avgAccuracy: accs.length > 0 ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
    avgCpl: cpls.length > 0 ? cpls.reduce((a, b) => a + b, 0) / cpls.length : null,
    queue: getQueueCounts(username),
  };
  return c.json(stats);
});

app.get("/api/style/:username", (c) => {
  const username = requireString(c.req.param("username"), "username");
  const { profile, updating } = readStyleProfile(username);
  return c.json({ ...profile, updating });
});

app.get("/api/recommend/:uuid/:ply", (c) => {
  const username = requireString(c.req.query("username"), "username");
  const ply = Number(c.req.param("ply"));
  const tolerance = Number(c.req.query("tolerance") ?? 30);
  if (!Number.isInteger(ply) || ply < 1 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
    throw new ApiFailure(400, "invalid ply or tolerance");
  }
  const decision = getDecision(username, c.req.param("uuid"), ply);
  if (!decision) throw new ApiFailure(404, "No analyzed player decision at this position");
  // Use the stored profile even when stale. The style route schedules any retrain,
  // so this path stays a single-row lookup without the aggregate signature query.
  const profile = storedProfile(username);
  if (!profile) {
    const engineBest = decision.candidates[0] ?? null;
    return c.json({ engineBest, forYou: null, reason: "Your style profile is still being built.", tolerance });
  }
  return c.json(recommend(decision, profile, tolerance, c.req.query("mode") !== "combined"));
});

const distDir = path.resolve(import.meta.dir, "../../web/dist");

// Unknown API paths stay JSON even when the web build is present.
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// Serve the built web app from disk with explicit Content-Type headers.
app.get("*", (c) => serveWebApp(distDir, new URL(c.req.url).pathname));

export default app;
