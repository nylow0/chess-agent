import { expect, test } from "bun:test";
import { capturedSummary } from "../src/lib/chessUtils";

test("promotion preserves actual captures and credits the material on the board", () => {
  const moves = ["a4", "h5", "a5", "h4", "a6", "h3", "axb7", "hxg2", "bxa8=Q"];

  expect(capturedSummary(moves)).toEqual({
    white: { roles: ["p", "r"], lead: 13 },
    black: { roles: ["p"], lead: null },
  });

  expect(capturedSummary(moves.slice(0, -1))).toEqual({
    white: { roles: ["p"], lead: null },
    black: { roles: ["p"], lead: null },
  });
});

test("en passant counts the captured pawn", () => {
  const moves = ["e4", "a6", "e5", "d5", "exd6"];
  expect(capturedSummary(moves)).toEqual({
    white: { roles: ["p"], lead: 1 },
    black: { roles: [], lead: null },
  });
});
