import { expect, test } from "@playwright/test";
import type { GameAnalysis, GameDetail, ProfileStats } from "../packages/shared/src";
import { blockChessCom, player, signIn } from "./helpers";

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const game: GameDetail = {
  uuid: "client-logic",
  chessComId: "client-logic",
  timeControl: "600",
  timeClass: "rapid",
  rated: true,
  playedAt: 1_700_000_000,
  white: { username: player, rating: 1500, result: "win" },
  black: { username: "opponent", rating: 1500, result: "loss" },
  analyzed: false,
  pgn: "1. e4",
  moves: ["e4"],
  fens: [startFen, afterE4],
};
const analysis: GameAnalysis = {
  gameUuid: game.uuid,
  engine: { name: "fixture", version: "1", depth: 14, multiPv: 1 },
  moves: [{
    ply: 1, san: "e4", uci: "e2e4", fenBefore: startFen, fenAfter: afterE4,
    cpBefore: 0, cpAfter: 0, mateBefore: null, mateAfter: null,
    cpl: 0, classification: "best", bestMove: "e2e4", bestMoveSan: "e4", lines: [],
  }],
  summary: {
    myAccuracy: 100, myCpl: 0, opponentAccuracy: 100,
    counts: { best: 1, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
  },
};
const profile: ProfileStats = {
  username: player, games: 1, analyzedGames: 0, wins: 1, draws: 0, losses: 0,
  winRate: 1, avgAccuracy: null, avgCpl: null,
  queue: { pending: 0, running: 0, failed: 0 },
};

test.beforeEach(async ({ page }) => {
  await blockChessCom(page);
});

test("review sends the encoded current player to game and analysis reads", async ({ page }) => {
  const name = "Lo ZaH0&viewer=other";
  const seen: URL[] = [];
  await page.route(/\/api\/games\/client-logic(?:\?|$)/, (route) => {
    seen.push(new URL(route.request().url()));
    return route.fulfill({ json: { ...game, white: { ...game.white, username: name } } });
  });
  await page.route(/\/api\/analysis\/client-logic(?:\?|$)/, (route) => {
    seen.push(new URL(route.request().url()));
    return route.fulfill({ json: { status: "done", analysis } });
  });
  await page.route("**/api/recommend/**", (route) =>
    route.fulfill({ json: { engineBest: null, forYou: null, reason: "fixture", tolerance: 30 } }),
  );
  await signIn(page, name);
  await page.goto(`/#/game/${game.uuid}`);
  await expect(page.getByRole("region", { name: "Next move" })).toBeVisible();
  expect(seen).toHaveLength(2);
  for (const url of seen) {
    expect(url.search).toBe(`?username=${encodeURIComponent(name)}`);
    expect(url.searchParams.get("username")).toBe(name);
  }
});

test("a slow review poll cannot overlap or revive a terminal spinner", async ({ page }) => {
  let calls = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/games\/client-logic(?:\?|$)/, (route) => route.fulfill({ json: game }));
  await page.route(/\/api\/analysis\/client-logic(?:\?|$)/, async (route) => {
    const call = ++calls;
    if (call === 2) await held;
    await route.fulfill({ json: call === 1 ? { status: "pending" }
      : call === 2 ? { status: "running" }
      : { status: "error", error: "terminal fixture failure" } });
  });
  await signIn(page);
  await page.goto(`/#/game/${game.uuid}`);
  try {
    await expect.poll(() => calls).toBe(2);
    // Hold the response across another complete poll period.
    await page.waitForTimeout(2300);
    expect(calls).toBe(2);
    release();
    await expect(page.getByRole("alert")).toContainText("terminal fixture failure", { timeout: 5000 });
    await page.waitForTimeout(4500);
    expect(calls).toBe(3);
    await expect(page.getByText("Analyzing. This can take a few minutes.", { exact: true })).toBeHidden();
    await expect(page.getByRole("alert")).toContainText("terminal fixture failure");
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

for (const change of ["tolerance", "mode"] as const) {
  test(`a failed ${change} change drops the incompatible suggestion and shows an error`, async ({ page }) => {
    let calls = 0;
    await page.route(/\/api\/games\/client-logic(?:\?|$)/, (route) => route.fulfill({ json: game }));
    await page.route(/\/api\/analysis\/client-logic(?:\?|$)/, (route) =>
      route.fulfill({ json: { status: "done", analysis } }),
    );
    await page.route("**/api/recommend/**", (route) => {
      const url = new URL(route.request().url());
      ++calls;
      if (calls === 2) return route.fulfill({ status: 503, json: { error: `${change} fixture failed` } });
      return route.fulfill({ json: {
        engineBest: null,
        forYou: { uci: "d2d4", san: "STYLE_FIXTURE", cp: -20, mate: null, pv: [], features: {}, value: -20 },
        reason: "20 cp below best", tolerance: Number(url.searchParams.get("tolerance")),
      } });
    });
    await signIn(page);
    await page.goto(`/#/game/${game.uuid}`);
    const next = page.getByRole("region", { name: "Next move" });
    await expect(next.getByText("STYLE_FIXTURE", { exact: true })).toBeVisible();
    const styleArrow = page.locator('svg.cg-shapes line[marker-end="url(#arrowhead-style)"]');
    await expect(styleArrow).toHaveCount(1);
    await next.getByText("Adjust", { exact: true }).click();
    if (change === "tolerance") {
      await next.getByLabel("Style tolerance").fill("0");
    } else {
      await next.getByLabel("Preference only").uncheck();
    }
    await expect(next.getByRole("alert")).toContainText(`${change} fixture failed`);
    await expect(next.getByText("STYLE_FIXTURE", { exact: true })).toBeHidden();
    await expect(styleArrow).toHaveCount(0);
    await page.screenshot({ path: `.artifacts/logic-fix/client/recommendation-${change}-error.png` });
    await next.getByRole("button", { name: "Try again" }).click();
    await expect(next.getByText("STYLE_FIXTURE", { exact: true })).toBeVisible();
    await expect(next.getByRole("alert")).toHaveCount(0);
    expect(calls).toBe(3);
  });
}

test("the dashboard keeps a newly synced game after a slow initial load", async ({ page }) => {
  let reads = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const added = { ...game, uuid: "newly-synced" };
  await page.route(/\/api\/games\?/, async (route) => {
    const call = ++reads;
    if (call === 1) await held;
    await route.fulfill({ json: call === 1 ? [game] : [added, game] });
  });
  await page.route("**/api/profile/*", (route) => route.fulfill({ json: { ...profile, games: 2 } }));
  await page.route("**/api/sync", (route) => route.fulfill({ json: { newGames: 1, totalGames: 2 } }));
  await signIn(page);
  await page.addInitScript((name) => { localStorage.setItem(`chess-last-sync:${name}`, "0"); }, player);
  const syncedResponse = page.waitForResponse((response) =>
    response.url().includes("/api/games?") && reads === 2,
  );
  await page.goto("/#/games");
  try {
    await expect.poll(() => reads).toBe(2);
    await syncedResponse;
    await page.waitForTimeout(200);
    release();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("summary-games")).toHaveText("2");
    await expect(page.getByTestId("game-newly-synced")).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("an accepted analyze survives one failed refresh and reconciles by polling", async ({ page }) => {
  let gamesReads = 0;
  let profileReads = 0;
  let posts = 0;
  await page.route(/\/api\/games\?/, (route) => {
    const call = ++gamesReads;
    return route.fulfill(call === 2
      ? { status: 503, json: { error: "temporary refresh failure" } }
      : { json: [{ ...game, analyzed: call > 2, ...(call > 2 ? { analysisStatus: "done", myAccuracy: 99 } : {}) }] });
  });
  await page.route("**/api/profile/*", (route) => {
    const call = ++profileReads;
    return route.fulfill(call === 2
      ? { status: 503, json: { error: "temporary refresh failure" } }
      : { json: profile });
  });
  await page.route("**/api/analyze", (route) => {
    posts++;
    return route.fulfill({ json: { queued: 1 } });
  });
  await signIn(page);
  await page.goto("/#/games");
  await page.getByRole("button", { name: "Analyze 1 new game", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("temporary refresh failure");
  await expect(page.getByRole("alert").getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`game-${game.uuid}`)).toBeVisible();
  await expect(page.getByTestId("queue-banner")).toContainText("1 left");
  await page.screenshot({ path: ".artifacts/logic-fix/client/dashboard-refresh-error.png" });
  await expect(page.getByTestId(`game-${game.uuid}`).locator("..").getByText("99.0%", { exact: true }))
    .toBeVisible({ timeout: 6500 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("queue-banner")).toHaveCount(0);
  await page.waitForTimeout(6500);
  expect(posts).toBe(1);
  expect(gamesReads).toBe(3);
  expect(profileReads).toBe(3);
});
