import { expect, test, type Locator, type Page } from "@playwright/test";
import type { GameSummary } from "../packages/shared/src";
import { blockChessCom, player, signIn } from "./helpers";

test.beforeEach(async ({ page }) => {
  await blockChessCom(page);
});

function opponentOf(game: GameSummary, name: string): string {
  return game.white.username.toLowerCase() === name.toLowerCase()
    ? game.black.username
    : game.white.username;
}

function resultOf(game: GameSummary, name: string): "win" | "loss" | "draw" {
  return game.white.username.toLowerCase() === name.toLowerCase()
    ? game.white.result
    : game.black.result;
}

async function rowUuids(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="game-"]')
    .evaluateAll((elements) =>
      elements.map((element) => (element.getAttribute("data-testid") ?? "").replace(/^game-/, "")),
    );
}

// A row whose box is fully on screen, so clicking it does not scroll the list.
async function rowInView(page: Page): Promise<{ row: Locator; testId: string }> {
  const rows = page.locator('[data-testid^="game-"]');
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const box = await row.boundingBox();
    if (box && box.y >= 60 && box.y + box.height <= 800) {
      return { row, testId: (await row.getAttribute("data-testid"))! };
    }
  }
  const first = rows.first();
  return { row: first, testId: (await first.getAttribute("data-testid"))! };
}

function syntheticGame(index: number): GameSummary {
  const timeClass = (["rapid", "blitz", "bullet", "daily"] as const)[index % 4];
  const mine = index % 3 === 0 ? "win" : index % 3 === 1 ? "loss" : "draw";
  return {
    uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    chessComId: `id-${index}`,
    timeControl: "600",
    timeClass,
    rated: true,
    playedAt: Date.now() - index * 3_600_000,
    white: { username: player, rating: 1500, result: mine },
    black: {
      username: `opponent${index}`,
      rating: 1500,
      result: mine === "win" ? "loss" : mine === "loss" ? "win" : "draw",
    },
    analyzed: false,
  };
}

test("filtering and the summary reflect the API", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const blitz = games.filter((game) => game.timeClass === "blitz");

  await page.getByRole("radio", { name: "Blitz" }).click();
  await expect(page.getByTestId("summary-games")).toHaveText(String(blitz.length));
  await expect(page.getByTestId("record-won")).toHaveText(
    String(blitz.filter((game) => resultOf(game, player) === "win").length),
  );
  await expect(page.getByTestId("record-drawn")).toHaveText(
    String(blitz.filter((game) => resultOf(game, player) === "draw").length),
  );
  await expect(page.getByTestId("record-lost")).toHaveText(
    String(blitz.filter((game) => resultOf(game, player) === "loss").length),
  );

  const blitzUuids = new Set(blitz.map((game) => game.uuid));
  for (const uuid of await rowUuids(page)) {
    expect(blitzUuids.has(uuid)).toBe(true);
  }

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("summary-games")).toHaveText(String(games.length));

  const opponent = games
    .map((game) => opponentOf(game, player))
    .find(
      (name, _index, names) =>
        names.filter((candidate) => candidate.toLowerCase() === name.toLowerCase()).length === 1,
    )!;
  const query = opponent.toLowerCase();
  const expected = games.filter(
    (game) =>
      opponentOf(game, player).toLowerCase().includes(query) ||
      (game.opening ?? "").toLowerCase().includes(query),
  );

  const search = page.getByRole("searchbox", { name: "Search games" });
  await search.fill(opponent);
  await expect(page.locator('[data-testid^="game-"]')).toHaveCount(expected.length);
  const expectedUuids = new Set(expected.map((game) => game.uuid));
  for (const uuid of await rowUuids(page)) {
    expect(expectedUuids.has(uuid)).toBe(true);
  }

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("summary-games")).toHaveText(String(games.length));

  expect(errors).toEqual([]);
});

test("sorting and paging", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const lowest = games
    .filter((game) => game.myAccuracy != null)
    .reduce((min, game) => ((game.myAccuracy ?? 0) < (min.myAccuracy ?? 0) ? game : min));

  await page.getByLabel("Sort").selectOption("accuracy-asc");
  await expect(page.locator('[data-testid^="game-"]').first()).toHaveAttribute(
    "data-testid",
    `game-${lowest.uuid}`,
  );

  const firstPage = Math.min(50, games.length);
  await expect(page.locator('[data-testid^="game-"]')).toHaveCount(firstPage);
  if (games.length > firstPage) {
    await page.getByRole("button", { name: "Show 50 more" }).click();
    await expect(page.locator('[data-testid^="game-"]')).toHaveCount(Math.min(100, games.length));
  }

  expect(errors).toEqual([]);
});

test("keeps filters, page size and scroll position after opening a game", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const losses = games.filter((game) => resultOf(game, player) === "loss");
  expect(losses.length).toBeGreaterThan(0);

  await page.getByRole("radio", { name: "Lost" }).click();
  const firstPage = Math.min(50, losses.length);
  await expect(page.locator('[data-testid^="game-"]')).toHaveCount(firstPage);
  let shown = firstPage;
  if (losses.length > firstPage) {
    await page.getByRole("button", { name: "Show 50 more" }).click();
    shown = Math.min(100, losses.length);
    await expect(page.locator('[data-testid^="game-"]')).toHaveCount(shown);
  }

  const row = page.locator('[data-testid^="game-"]').nth(shown - 1);
  const testId = await row.getAttribute("data-testid");
  await row.click();
  await expect.poll(() => page.url()).toContain("/#/game/");

  await page.goBack();
  await expect(page.getByRole("radio", { name: "Lost" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-testid^="game-"]')).toHaveCount(shown);
  await expect(page.getByTestId(testId!)).toBeInViewport();

  expect(errors).toEqual([]);
});

test("queue banner shows progress and stop cancels the queue", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page);

  await page.route("**/api/games**", async (route) => {
    const response = await route.fetch();
    const games = (await response.json()) as GameSummary[];
    const marked = games.map((game, index) =>
      index < 4
        ? {
            ...game,
            analyzed: false,
            analysisStatus: index === 3 ? "running" : "pending",
            myAccuracy: undefined,
            myCounts: undefined,
          }
        : index === 4
          ? { ...game, analyzed: false, analysisStatus: undefined, myAccuracy: undefined, myCounts: undefined }
          : game,
    );
    await route.fulfill({ status: 200, json: marked });
  });
  await page.route("**/api/profile/*", async (route) => {
    const response = await route.fetch();
    const profile = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      json: { ...profile, queue: { pending: 3, running: 1, failed: 0 } },
    });
  });
  let cancelled = 0;
  await page.route("**/api/analyze/cancel", async (route) => {
    cancelled += 1;
    await route.fulfill({ status: 200, json: { cancelled: 3 } });
  });
  const analyzeCalls: string[] = [];
  await page.route("**/api/analyze", async (route) => {
    analyzeCalls.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, json: { queued: 1 } });
  });

  await page.goto("/#/games");

  await expect(page.getByTestId("queue-banner")).toContainText(
    "Analyzing your games. 4 left, a few minutes each.",
  );
  await expect(page.getByText("Queued").first()).toBeVisible();
  await expect(page.getByText("Analyzing", { exact: true }).first()).toBeVisible();

  // A row's Analyze button must not open the game.
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect.poll(() => analyzeCalls.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(/#\/games$/);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => cancelled).toBeGreaterThan(0);

  // Stop triggers a refresh whose mocked routes may still be in flight; let it
  // settle so a late route.fetch rejection is not blamed on the next test.
  await page.unrouteAll({ behavior: "ignoreErrors" });

  expect(errors).toEqual([]);
});

test("phone layout has no horizontal overflow and rows are links", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/#/games");

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const first = page.locator('[data-testid^="game-"]').first();
  await expect(first).toBeVisible();
  expect(await first.evaluate((element) => element.tagName)).toBe("A");
  const href = await first.getAttribute("href");
  expect(href).toMatch(/^#\/game\//);
  expect(games.some((game) => href === `#/game/${game.uuid}`)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The header drops the username on a phone but keeps "Switch player".
  await expect(page.getByTestId("header-username")).toBeHidden();
  await expect(page.getByRole("button", { name: "Switch player" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("record stays on one line at desktop width", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/#/games");

  const tops = await page
    .locator('[data-testid="record"] > span')
    .evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().top));
  expect(tops.length).toBe(3);
  expect(new Set(tops).size).toBe(1);

  expect(errors).toEqual([]);
});

test("empty result shows a dash instead of a zero record", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");

  await page.getByRole("searchbox", { name: "Search games" }).fill("no-such-opponent-zzz");

  await expect(page.getByText("No games match these filters.")).toBeVisible();
  await expect(page.getByTestId("record-empty")).toHaveText("–");
  await expect(page.getByTestId("record-won")).toHaveCount(0);
  await expect(page.getByTestId("games-summary")).not.toContainText("analyzed games");

  expect(errors).toEqual([]);
});

test("at 768px every row shows result and accuracy with no page scroll", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page);
  await page.goto("/#/games");

  const first = page.locator('[data-testid^="game-"]').first();
  await expect(first).toBeVisible();

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);

  // The row is fully on screen, so its result and accuracy need no sideways scroll.
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(768 + 1);
  await expect(first.getByText(/^(Won|Lost|Draw)$/).first()).toBeVisible();
  await expect(first.getByText(/%$/).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("the header links keep the Games scroll position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");
  await expect(page.locator('[data-testid^="game-"]').first()).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(80);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);

  await page.getByRole("link", { name: "Style", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Games", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: "scroll restored after header links" })
    .toBeGreaterThan(before - 60);

  expect(errors).toEqual([]);
});

test("the review's All games link keeps the Games scroll position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto("/#/games");
  await expect(page.locator('[data-testid^="game-"]').first()).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(80);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);

  const { row, testId } = await rowInView(page);
  await row.click();
  await expect.poll(() => page.url()).toContain("/#/game/");

  await page.getByRole("link", { name: "All games", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: "scroll restored from All games" })
    .toBeGreaterThan(before - 60);
  await expect(page.getByTestId(testId)).toBeInViewport();

  expect(errors).toEqual([]);
});

test("the Stopped notice clears once the queue drains", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);

  let queue = { pending: 2, running: 1, failed: 0 };
  await page.route("**/api/profile/*", async (route) => {
    const response = await route.fetch();
    const profile = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ status: 200, json: { ...profile, queue } });
  });
  await page.route("**/api/analyze/cancel", (route) => {
    // Stop cancels the waiting games; the running one still finishes.
    queue = { pending: 0, running: 1, failed: 0 };
    return route.fulfill({ status: 200, json: { cancelled: 2 } });
  });

  await page.goto("/#/games");
  await expect(page.getByTestId("queue-banner")).toContainText("3 left");

  await page.getByRole("button", { name: "Stop" }).click();
  const stopped = page.getByText("Stopped. The game being analyzed right now will still finish.");
  await expect(stopped).toBeVisible();

  // The running game finishes, so the next poll sees an empty queue.
  queue = { pending: 0, running: 0, failed: 0 };
  await expect(stopped).toBeHidden({ timeout: 8000 });

  expect(errors).toEqual([]);
});

test("the time-control filter wraps instead of widening the phone page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  const games = Array.from({ length: 5000 }, (_, index) => syntheticGame(index));
  await page.route(/\/api\/games\?/, (route) => route.fulfill({ status: 200, json: games }));
  await page.route(/\/api\/profile\//, (route) =>
    route.fulfill({
      status: 200,
      json: {
        username: player,
        games: games.length,
        analyzedGames: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        winRate: 0,
        avgAccuracy: null,
        avgCpl: null,
        queue: { pending: 0, running: 0, failed: 0 },
      },
    }),
  );

  await page.goto("/#/games");
  await expect(page.getByText("Showing 50 of 5000 games")).toBeVisible({ timeout: 20000 });

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);

  const group = page.getByRole("radiogroup", { name: "Time control" });
  const box = await group.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
});

test("one imported game is described in the singular", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 200, json: { newGames: 1, totalGames: 1 } }),
  );

  await page.goto("/#/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync games" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Imported" })).toHaveText(
    "Imported 1 new game.",
  );
});
