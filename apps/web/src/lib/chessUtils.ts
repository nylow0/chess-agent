import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { GameSummary } from "@shared";

export interface PlyRow {
  ply: number;
  moveNumber: number;
  white: boolean;
  san: string;
}

export function buildPlyRows(moves: string[]): PlyRow[] {
  return moves.map((san, i) => ({
    ply: i + 1,
    moveNumber: Math.floor(i / 2) + 1,
    white: i % 2 === 0,
    san,
  }));
}

export function firstUciToken(uci: string): string {
  return uci.split(/\s+/)[0] ?? "";
}

export function uciToKeys(uci: string): [string, string] | null {
  const token = firstUciToken(uci);
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) return null;
  return [token.slice(0, 2), token.slice(2, 4)];
}

export function pvToSan(fen: string, pv: string[], maxPlies: number): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, maxPlies)) {
    const keys = uciToKeys(uci);
    if (!keys) break;
    const token = firstUciToken(uci);
    try {
      const move = chess.move({
        from: keys[0] as Square,
        to: keys[1] as Square,
        promotion: token[4] as "q" | "r" | "b" | "n" | undefined,
      });
      out.push(move.san);
    } catch {
      break;
    }
  }
  return out;
}

export function uciAtPly(moves: string[], ply: number): string | null {
  if (ply < 1 || ply > moves.length) return null;
  try {
    const chess = new Chess();
    for (const san of moves.slice(0, ply)) chess.move(san);
    const history = chess.history({ verbose: true });
    const last = history[history.length - 1];
    if (!last) return null;
    return `${last.from}${last.to}${last.promotion ?? ""}`;
  } catch {
    return null;
  }
}

export function moverIsWhiteAtPly(ply: number): boolean {
  return ply % 2 === 1;
}

/** White's win chance in percent for a White-point-of-view score, without mate handling. */
export function winPercent(cp: number): number {
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}

/** White's win chance in percent, pinning forced mates to 0 or 100. */
export function winChance(cp: number | null, mate: number | null): number {
  if (mate !== null) return (mate === 0 ? (cp ?? 0) > 0 : mate > 0) ? 100 : 0;
  if (cp === null) return 50;
  return winPercent(cp);
}

/** True for the three move grades the player should actually study. */
export function isNotable(classification: string): boolean {
  return (
    classification === "inaccuracy" ||
    classification === "mistake" ||
    classification === "blunder"
  );
}

export function evalLabel(cp: number | null, mate: number | null): string {
  if (mate !== null) {
    // Mate 0 is checkmate on the board; the sign of the score names the winner.
    if (mate === 0) return (cp ?? 0) > 0 ? "1-0" : "0-1";
    return `#${mate}`;
  }
  if (cp === null) return "–";
  const pawns = cp / 100;
  if (Math.abs(pawns) > 20) return pawns > 0 ? "+20" : "−20";
  return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(1)}`;
}

export function moverIsWhite(game: GameSummary, username: string | null): boolean {
  if (!username) return true;
  return game.white.username.toLowerCase() === username.toLowerCase();
}

export function myResult(
  game: GameSummary,
  username: string | null,
): "win" | "loss" | "draw" | null {
  if (!username) return null;
  const me = username.toLowerCase();
  if (game.white.username.toLowerCase() === me) return game.white.result;
  if (game.black.username.toLowerCase() === me) return game.black.result;
  return null;
}

export const CLASSIFICATION_GLYPH: Record<string, string> = {
  best: "",
  excellent: "",
  good: "",
  book: "",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

export const CLASSIFICATION_COLOR: Record<string, string> = {
  best: "text-cls-best",
  excellent: "text-cls-excellent",
  good: "text-cls-good",
  book: "text-cls-good",
  inaccuracy: "text-cls-inaccuracy",
  mistake: "text-cls-mistake",
  blunder: "text-cls-blunder",
};

/** Badge disc and graph dot colours, usable from inline styles and SVG. */
export const CLASSIFICATION_VAR: Record<string, string> = {
  best: "var(--color-cls-best)",
  excellent: "var(--color-cls-excellent)",
  good: "var(--color-cls-good)",
  book: "var(--color-cls-book)",
  inaccuracy: "var(--color-cls-inaccuracy)",
  mistake: "var(--color-cls-mistake)",
  blunder: "var(--color-cls-blunder)",
};

export const CLASSIFICATION_LABEL: Record<string, string> = {
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  book: "Book",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

export function normalizeTime(t: number): number {
  return t < 1e12 ? t * 1000 : t;
}

/** Reads a PGN header tag such as `[Termination "..."]`. */
export function pgnTermination(pgn: string): string | null {
  const match = /\[Termination "([^"]*)"\]/.exec(pgn);
  return match ? match[1] : null;
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface CapturedSide {
  /** Roles of the opponent pieces this side has captured, cheapest first. */
  roles: string[];
  /** Material lead in pawns, shown on the side that is ahead. */
  lead: number | null;
}

/** Actual captures and material lead from replaying the move prefix. */
export function capturedSummary(
  moves: string[],
  initialFen?: string,
): { white: CapturedSide; black: CapturedSide } {
  const captures: Record<"w" | "b", string[]> = { w: [], b: [] };
  const chess = new Chess(initialFen);
  for (const san of moves) {
    const move = chess.move(san);
    if (move.captured) captures[move.color].push(move.captured);
  }

  let diff = 0;
  for (const piece of chess.board().flat()) {
    if (piece) diff += PIECE_VALUE[piece.type] * (piece.color === "w" ? 1 : -1);
  }

  const byValue = (a: string, b: string) => PIECE_VALUE[a] - PIECE_VALUE[b];

  return {
    white: { roles: captures.w.sort(byValue), lead: diff > 0 ? diff : null },
    black: { roles: captures.b.sort(byValue), lead: diff < 0 ? -diff : null },
  };
}
