import { Chess, type Color, type Square } from "chess.js";
import type { MoveFeatures } from "@chess/shared";

const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const opposite = (color: Color): Color => color === "w" ? "b" : "w";

function legalCount(chess: Chess, color: Color): number {
  const fields = chess.fen().split(" ");
  if (fields[1] !== color) {
    fields[1] = color;
    fields[3] = "-";
  }
  return new Chess(fields.join(" ")).moves().length;
}

function distance(a: Square, b: Square): number {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}

function material(chess: Chess, color: Color): number {
  return chess.board().flat().reduce((sum, p) => sum + (p ? values[p.type] * (p.color === color ? 1 : -1) : 0), 0);
}

/** Root-move features, in mover POV. PV recaptures expose exchanges and material risk. */
export function features(fenBefore: string, uci: string, pv: string[] = [], spreadCp = 0): MoveFeatures {
  const before = new Chess(fenBefore);
  const color = before.turn();
  const enemy = opposite(color);
  const after = new Chess(fenBefore);
  const move = after.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const pieces = after.board().flat().filter(p => p !== null);
  const ownKing = pieces.find(p => p.type === "k" && p.color === color)!;
  const enemyKing = pieces.find(p => p.type === "k" && p.color === enemy)!;
  const enemyFile = enemyKing.square.charCodeAt(0) - 97;
  const moveFile = move.to.charCodeAt(0) - 97;
  let locked = 0;
  let openFiles = 0;
  for (const file of "abcdefgh") {
    if (!pieces.some(p => p.type === "p" && p.square[0] === file)) openFiles++;
    if (!"cdef".includes(file)) continue;
    for (let rank = 2; rank <= 6; rank++) {
      const lower = after.get(`${file}${rank}` as Square);
      const upper = after.get(`${file}${rank + 1}` as Square);
      if (lower?.type === "p" && lower.color === "w" && upper?.type === "p" && upper.color === "b") locked++;
    }
  }
  const shield = pieces.filter(p => p.color === color && p.type === "p" && distance(p.square, ownKing.square) === 1 &&
    (Number(p.square[1]) - Number(ownKing.square[1])) * (color === "w" ? 1 : -1) > 0).length;
  const castledKing = (color === "w" ? ["c1", "g1"] : ["c8", "g8"]).includes(ownKing.square);
  let attacked = 0;
  for (const file of "abcdefgh") for (let rank = 1; rank <= 8; rank++) {
    const square = `${file}${rank}` as Square;
    if (distance(square, ownKing.square) <= 1 && after.isAttacked(square, enemy)) attacked++;
  }
  const continuation = new Chess(after.fen());
  let recaptured = false;
  if (pv[1]) {
    try {
      const reply = continuation.move({ from: pv[1].slice(0, 2), to: pv[1].slice(2, 4), promotion: pv[1][4] });
      recaptured = Boolean(move.captured && reply.captured && reply.to === move.to);
    } catch { /* A truncated PV leaves immediate features intact. */ }
  }
  const nonPawnMaterial = pieces.reduce((sum, p) => sum + (p.type === "p" ? 0 : values[p.type]), 0);
  return {
    trades: Number(recaptured),
    queensOff: Number(!pieces.some(p => p.type === "q")),
    centerLock: locked,
    openFiles,
    aggression: Number(after.isCheck()) + Number(Boolean(move.captured)) + (3 - Math.min(3, distance(move.to, enemyKing.square))) / 3,
    pawnStorm: Number(move.piece === "p" && ((enemyFile <= 2 && moveFile <= 2) || (enemyFile >= 5 && moveFile >= 5))) * Math.abs(Number(move.to[1]) - Number(move.from[1])),
    kingSafety: shield + Number(castledKing) - attacked,
    materialRisk: Math.max(0, material(before, color) - material(continuation, color)),
    activity: legalCount(after, color) - legalCount(before, color),
    restriction: legalCount(before, enemy) - after.moves().length,
    complexity: Math.min(1000, spreadCp) / 100,
    endgame: Number(nonPawnMaterial <= 20),
    development: Number(["n", "b"].includes(move.piece) && move.from[1] === (color === "w" ? "1" : "8") && move.to[1] !== move.from[1]) + Number(move.isKingsideCastle() || move.isQueensideCastle()),
    centerControl: (["d4", "e4", "d5", "e5"] as Square[]).reduce((sum, square) => sum + Number(after.isAttacked(square, color)) - Number(before.isAttacked(square, color)), 0),
  };
}

export function moveClocks(pgn: string, timeControl: string): Map<string, { left: number | null; spent: number | null }> {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const comments = new Map(chess.getComments().map(c => [c.fen, c.comment]));
  const match = timeControl.match(/^(\d+)(?:\+(\d+))?$/);
  const base = match ? Number(match[1]) : null;
  const increment = match ? Number(match[2] ?? 0) : 0;
  const previous: Record<Color, number | null> = { w: base, b: base };
  const clocks = new Map<string, { left: number | null; spent: number | null }>();
  for (const move of chess.history({ verbose: true })) {
    const clock = comments.get(move.after)?.match(/\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/);
    const left = clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : null;
    const prior = previous[move.color];
    const spent = left !== null && prior !== null && match ? Math.max(0, prior + increment - left) : null;
    clocks.set(move.after, { left, spent });
    previous[move.color] = left;
  }
  return clocks;
}
