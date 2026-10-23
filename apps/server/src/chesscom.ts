import type { GameResult, SyncResult } from "@chess/shared";
import { Chess } from "chess.js";
import { db } from "./db";

const USER_AGENT = "chess-analyst-local/0.1 (local study tool)";
const MAX_MONTHS = 6;

export class NotFoundError extends Error {}

interface ChessComPlayer {
  username?: string;
  avatar?: string;
  url?: string;
  joined?: number;
  followers?: number;
}

interface ChessComGameSide {
  username: string;
  rating: number;
  result: string;
}

interface ChessComGame {
  uuid: string;
  url: string;
  pgn: string;
  time_control: string;
  time_class: string;
  rated: boolean;
  end_time: number;
  eco?: string;
  /** "chess" for standard games; variants (chess960, bughouse, ...) set another value. */
  rules?: string;
  white: ChessComGameSide;
  black: ChessComGameSide;
}

const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 10_000;

export type FetchDelay = (ms: number) => Promise<void>;
const sleep: FetchDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function chessComFetch(url: string, delay: FetchDelay = sleep): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    } catch (err) {
      throw new Error(`chess.com request failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    // 404 and any other client error except rate limiting mean the player or
    // archive is not there. Chess.com answers 410 for odd names and pasted URLs.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new NotFoundError(`not found on chess.com: ${url}`);
    }
    if (!res.ok) {
      // 429 and 5xx are transient: wait and retry with a growing delay.
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < MAX_RETRIES) {
        const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS)
          : 1000 * 2 ** attempt;
        await delay(waitMs);
        continue;
      }
      throw new Error(`chess.com returned HTTP ${res.status} for ${url}`);
    }
    return res.json();
  }
}

export async function fetchPlayer(username: string): Promise<ChessComPlayer> {
  const player = await chessComFetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}`);
  return player as ChessComPlayer;
}

export function toGameResult(result: string): GameResult {
  if (result === "win" || result === "kingofthehill" || result === "threecheck") return "win";
  if (["agree", "agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"].includes(result)) return "draw";
  return "loss";
}

// Chess.com slugs drop apostrophes and hyphens; restore the common names word by word.
const OPENING_REPLACEMENTS: [RegExp, string][] = [
  [/\bKings\b/g, "King's"], [/\bQueens\b/g, "Queen's"], [/\bBishops\b/g, "Bishop's"],
  [/\bPetrovs\b/g, "Petrov's"], [/\bBirds\b/g, "Bird's"], [/\bOwens\b/g, "Owen's"],
  [/\bAlekhines\b/g, "Alekhine's"], [/\bPhilidors\b/g, "Philidor's"], [/\bLarsens\b/g, "Larsen's"],
  [/\bCaro Kann\b/g, "Caro-Kann"], [/\bNimzo Indian\b/g, "Nimzo-Indian"],
  [/\bNimzowitsch Larsen\b/g, "Nimzowitsch-Larsen"],
];

/** Cut the trailing move notation Chess.com appends to ECO names. */
export function cleanOpeningName(opening: string | null | undefined): string | null {
  if (!opening) return null;
  // A name is followed either by " 4.d4" move text or by a "..." suffix. The
  // bare move number before "..." ("...3...cxd5") is left behind, so drop a
  // trailing numeric token too, without touching numbers inside the name.
  const name = opening.split("...")[0].replace(/\s\d+\..*$/, "").replace(/\s\d+$/, "").trim();
  if (!name) return opening;
  return OPENING_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), name);
}

/** True when chess.js parses the PGN and it contains at least one move. */
function hasMoves(pgn: string): boolean {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.history().length > 0;
  } catch {
    return false;
  }
}

function openingSlug(eco: string | undefined): string | null {
  if (!eco) return null;
  const last = eco.split("/").pop() ?? "";
  if (!last) return null;
  return cleanOpeningName(decodeURIComponent(last).replace(/-/g, " "));
}

export async function syncGames(username: string, allHistory = false, now = new Date()): Promise<SyncResult> {
  const archivesPayload = (await chessComFetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`
  )) as { archives?: unknown };
  const archives = archivesPayload.archives;
  if (!Array.isArray(archives)) throw new Error("unexpected archives response from chess.com");
  const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const monthUrls = archives.filter((url): url is string => {
    if (typeof url !== "string") return false;
    if (allHistory) return true;
    const match = url.match(/\/(\d{4})\/(0[1-9]|1[0-2])$/);
    if (!match) return false;
    const month = Number(match[1]) * 12 + Number(match[2]) - 1;
    return month <= currentMonth && month > currentMonth - MAX_MONTHS;
  });

  let newGames = 0;
  for (const monthUrl of monthUrls) {
    let payload: { games?: ChessComGame[] };
    try {
      payload = (await chessComFetch(monthUrl)) as { games?: ChessComGame[] };
    } catch (err) {
      // A single month archive may be missing/expired — skip it, don't fail the sync.
      if (err instanceof NotFoundError) continue;
      throw err;
    }
    for (const g of payload.games ?? []) {
      if (!g.uuid || typeof g.pgn !== "string") continue;
      // Variants cannot be reviewed as standard chess; aborted games have no moves.
      if (g.rules && g.rules !== "chess") continue;
      if (!hasMoves(g.pgn)) continue;
      const existed = db.query("SELECT uuid FROM games WHERE uuid = ?").get(g.uuid);
      db.run(
        `INSERT INTO games
         (uuid, pgn, url, time_control, time_class, rated, end_time,
          white_username, white_rating, white_result,
          black_username, black_rating, black_result, opening)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET white_result = excluded.white_result,
           black_result = excluded.black_result`,
        [
          g.uuid,
          g.pgn,
          g.url ?? null,
          g.time_control ?? null,
          g.time_class ?? null,
          g.rated ? 1 : 0,
          g.end_time ?? 0,
          g.white?.username ?? null,
          g.white?.rating ?? 0,
          toGameResult(g.white?.result ?? ""),
          g.black?.username ?? null,
          g.black?.rating ?? 0,
          toGameResult(g.black?.result ?? ""),
          openingSlug(g.eco),
        ]
      );
      if (!existed) newGames++;
    }
  }

  const totalRow = db
    .query("SELECT COUNT(*) AS n FROM games WHERE white_username = ? COLLATE NOCASE OR black_username = ? COLLATE NOCASE")
    .get(username, username) as { n: number };
  return { newGames, totalGames: totalRow.n };
}
