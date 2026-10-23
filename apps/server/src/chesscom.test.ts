import { afterEach, expect, test } from "bun:test";
import { db } from "./db";
import { chessComFetch, cleanOpeningName, NotFoundError, syncGames, toGameResult } from "./chesscom";
import app from "./routes";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("opening names drop move text and restore apostrophes and hyphens", () => {
  expect(cleanOpeningName("Sicilian Defense Canal Attack...4.d4 cxd4")).toBe("Sicilian Defense Canal Attack");
  expect(cleanOpeningName("Kings Indian Defense Normal Variation...6.h3 Nbd7")).toBe("King's Indian Defense Normal Variation");
  expect(cleanOpeningName("Caro Kann Defense Advance Short Variation with 4 Nf3...e6")).toBe("Caro-Kann Defense Advance Short Variation with 4 Nf3");
  expect(cleanOpeningName("Petrovs Defense Three Knights Game")).toBe("Petrov's Defense Three Knights Game");
  expect(cleanOpeningName("Giuoco Piano Game 4.O O d6 5.c3 Nf6")).toBe("Giuoco Piano Game");
  expect(cleanOpeningName("Caro Kann Defense Exchange Variation 3...cxd5")).toBe("Caro-Kann Defense Exchange Variation");
  expect(cleanOpeningName("Indian Game East Indian London System 3...Bf5")).toBe("Indian Game East Indian London System");
});

test("variant win codes map to a win", () => {
  expect(toGameResult("kingofthehill")).toBe("win");
  expect(toGameResult("threecheck")).toBe("win");
  expect(toGameResult("checkmated")).toBe("loss");
});

test("sync skips variants and moveless games and imports standard games", async () => {
  const month = "https://api.chess.com/pub/player/sync-user/games/2024/01";
  const games = [
    {
      uuid: "sync-std", pgn: "1. e4 e5 2. Nf3", time_control: "600", time_class: "blitz", rated: true,
      end_time: 1700000000, rules: "chess",
      white: { username: "sync-user", rating: 1500, result: "win" }, black: { username: "opp", rating: 1400, result: "checkmated" },
    },
    {
      uuid: "sync-960", pgn: "1. e4 e5", time_control: "600", time_class: "blitz", rated: true,
      end_time: 1700000100, rules: "chess960",
      white: { username: "sync-user", rating: 1500, result: "win" }, black: { username: "opp", rating: 1400, result: "checkmated" },
    },
    {
      uuid: "sync-empty", pgn: "", time_control: "600", time_class: "blitz", rated: true,
      end_time: 1700000200, rules: "chess",
      white: { username: "sync-user", rating: 1500, result: "win" }, black: { username: "opp", rating: 1400, result: "loss" },
    },
    {
      uuid: "sync-koth", pgn: "1. e4 e5", time_control: "600", time_class: "blitz", rated: true,
      end_time: 1700000300, rules: "chess",
      white: { username: "sync-user", rating: 1500, result: "kingofthehill" }, black: { username: "opp", rating: 1400, result: "checkmated" },
    },
  ];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/games/archives")) return jsonResponse({ archives: [month] });
    if (url === month) return jsonResponse({ games });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const result = await syncGames("sync-user", false, new Date("2024-01-15T12:00:00Z"));
  expect(result.newGames).toBe(2);
  expect(db.query("SELECT uuid FROM games WHERE uuid = 'sync-std'").get()).not.toBeNull();
  expect(db.query("SELECT uuid FROM games WHERE uuid = 'sync-960'").get()).toBeNull();
  expect(db.query("SELECT uuid FROM games WHERE uuid = 'sync-empty'").get()).toBeNull();
  const koth = db.query<{ white_result: string }, []>("SELECT white_result FROM games WHERE uuid = 'sync-koth'").get()!;
  expect(koth.white_result).toBe("win");
});

test("recent sync selects six calendar months across a year boundary, with sparse archives", async () => {
  const months = ["2019/01", "2025/06", "2025/07", "2025/08", "2025/12", "2026/01", "2026/02"];
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/archives")) return jsonResponse({ archives: months.map(month => `https://api.chess.com/pub/player/window-user/games/${month}`) });
    requested.push(url.slice(-7));
    return jsonResponse({ games: [] });
  }) as unknown as typeof fetch;
  const now = new Date("2026-01-01T00:00:00Z");
  await syncGames("window-user", false, now);
  expect(requested).toEqual(["2025/08", "2025/12", "2026/01"]);
  requested.length = 0;
  await syncGames("window-user", true, now);
  expect(requested).toEqual(months);
});

test("a 429 is retried with the Retry-After delay and no real waiting", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", { status: 429, headers: { "Retry-After": "2" } })
      : jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const waits: number[] = [];
  const payload = await chessComFetch("https://api.chess.com/pub/player/x", async (ms) => { waits.push(ms); });
  expect(payload).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(waits).toEqual([2000]);
});

test("a persistent 5xx is retried with growing delays then fails", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("boom", { status: 503 });
  }) as unknown as typeof fetch;

  const waits: number[] = [];
  await expect(chessComFetch("https://api.chess.com/pub/player/x", async (ms) => { waits.push(ms); }))
    .rejects.toThrow("HTTP 503");
  expect(calls).toBe(4);
  expect(waits).toEqual([1000, 2000, 4000]);
});

test("client errors other than 429 read as player not found, not an internal error", async () => {
  for (const status of [403, 404, 410]) {
    globalThis.fetch = (async () => new Response("gone", { status })) as unknown as typeof fetch;
    await expect(chessComFetch("https://api.chess.com/pub/player/odd")).rejects.toBeInstanceOf(NotFoundError);

    const response = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "odd name" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'player "odd name" not found on chess.com' });
  }
});
