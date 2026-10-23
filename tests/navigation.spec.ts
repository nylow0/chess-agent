import { expect, test } from "@playwright/test";
import type { GameSummary } from "../packages/shared/src";
import { blockChessCom, player, seedSync, signIn } from "./helpers";
test("hash routing walks the real workflow", async ({ page, request }) => {
  const username = player;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  // Chess.com is answered locally, and a fresh sync timestamp keeps the quiet
  // background sync out of the test. The login form itself is still exercised.
  await blockChessCom(page);
  await seedSync(page);

  await page.goto("/");
  await page.getByRole("textbox", { name: "Chess.com username" }).fill(username);
  await page.getByRole("button", { name: "Open my games" }).click();

  // Signed in on the games list, and the hash says so.
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  expect(page.url()).toMatch(/#\/games$/);

  const gamesResponse = await request.get(`/api/games?username=${username}`);
  const games = await gamesResponse.json() as GameSummary[];
  const game = games.find(candidate => candidate.analyzed)!;
  expect(game).toBeDefined();

  await page.getByTestId(`game-${game.uuid}`).click();
  await expect.poll(() => page.url()).toContain(`#/game/${game.uuid}`);

  const nextMove = page.getByRole("button", { name: "Next move", exact: true });
  await nextMove.click();
  await nextMove.click();
  await nextMove.click();
  await expect(page.locator("span").filter({ hasText: /^3 \/ \d+$/ })).toBeVisible();
  expect(page.url()).toContain("ply=3");

  // A reload restores the same game at the same ply.
  await page.reload();
  await expect(page.locator("span").filter({ hasText: /^3 \/ \d+$/ })).toBeVisible();
  expect(page.url()).toContain(`#/game/${game.uuid}`);

  // Back returns to the games list; the shell moves between views.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Style", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  expect(page.url()).toMatch(/#\/style$/);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Switch player", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chess.com username" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("signing in does not sync twice", async ({ page }) => {
  let syncs = 0;
  await page.route("**/api/login", (route) =>
    route.fulfill({ status: 200, json: { username: player } }),
  );
  await page.route("**/api/sync", (route) => {
    syncs += 1;
    return route.fulfill({ status: 200, json: { newGames: 0, totalGames: 0 } });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Chess.com username" }).fill(player);
  await page.getByRole("button", { name: "Open my games" }).click();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);

  expect(syncs).toBe(1);
});

test("a pasted Chess.com profile URL signs in as that username", async ({ page }) => {
  const bodies: string[] = [];
  await page.route("**/api/login", (route) => {
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({ status: 200, json: { username: player } });
  });
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 200, json: { newGames: 0, totalGames: 0 } }),
  );

  await page.goto("/");
  const urls = [`https://www.chess.com/member/${player}`, `chess.com/member/${player}/`];
  for (const url of urls) {
    await page.getByRole("textbox", { name: "Chess.com username" }).fill(url);
    await page.getByRole("button", { name: "Open my games" }).click();
    await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
    expect(JSON.parse(bodies.at(-1)!).username).toBe(player);
    await page.getByRole("button", { name: "Switch player" }).click();
    await expect(page.getByRole("textbox", { name: "Chess.com username" })).toBeVisible();
  }
});

test("each screen has its own page title", async ({ page, request }) => {
  await blockChessCom(page);
  await seedSync(page);

  await page.goto("/");
  await expect.poll(() => page.title()).toBe("Sign in · Post-mortem");

  await page.getByRole("textbox", { name: "Chess.com username" }).fill(player);
  await page.getByRole("button", { name: "Open my games" }).click();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await expect.poll(() => page.title()).toBe("Games · Post-mortem");

  await page.getByRole("link", { name: "Style", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  await expect.poll(() => page.title()).toBe("Style · Post-mortem");

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const game = games.find((candidate) => candidate.analyzed)!;
  await page.goto(`/#/game/${game.uuid}`);
  await expect.poll(() => page.title()).toBe("Review · Post-mortem");
});

test("no horizontal page scroll at 360px on games, style and review", async ({ page, request }) => {
  await blockChessCom(page);
  await signIn(page);

  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const game = games.find((candidate) => candidate.analyzed)!;

  await page.setViewportSize({ width: 360, height: 640 });
  for (const hash of ["#/games", "#/style", `#/game/${game.uuid}?ply=20`]) {
    await page.goto(`/${hash}`);
    await expect(page.locator("header").first()).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        { message: `no page overflow on ${hash}` },
      )
      .toBeLessThanOrEqual(0);
  }
});

test("the app still works when localStorage is blocked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is not available");
      },
    });
  });
  await page.route("**/api/login", (route) =>
    route.fulfill({ status: 200, json: { username: player } }),
  );
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 200, json: { newGames: 0, totalGames: 0 } }),
  );

  await page.goto("/");
  await page.getByRole("textbox", { name: "Chess.com username" }).fill(player);
  await page.getByRole("button", { name: "Open my games" }).click();
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

// WCAG relative luminance ratio for a colour and the opaque background behind it.
async function placeholderContrast(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) throw new Error(`missing ${sel}`);
    function parse(color: string): number[] {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return [0, 0, 0, 1];
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    let node: Element | null = element;
    const stack: number[][] = [];
    let base: number[] = [0, 0, 0, 1];
    while (node) {
      const background = parse(getComputedStyle(node).backgroundColor);
      if (background[3] > 0) {
        stack.push(background);
        if (background[3] >= 0.999) break;
      }
      node = node.parentElement;
    }
    for (let index = stack.length - 1; index >= 0; index--) {
      const layer = stack[index];
      const alpha = layer[3];
      base = [
        layer[0] * alpha + base[0] * (1 - alpha),
        layer[1] * alpha + base[1] * (1 - alpha),
        layer[2] * alpha + base[2] * (1 - alpha),
        1,
      ];
    }
    const foreground = parse(getComputedStyle(element, "::placeholder").color);
    const alpha = foreground[3];
    const over = [
      foreground[0] * alpha + base[0] * (1 - alpha),
      foreground[1] * alpha + base[1] * (1 - alpha),
      foreground[2] * alpha + base[2] * (1 - alpha),
      1,
    ];
    function luminance(color: number[]): number {
      const [r, g, b] = color.slice(0, 3).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const high = Math.max(luminance(over), luminance(base));
    const low = Math.min(luminance(over), luminance(base));
    return (high + 0.05) / (low + 0.05);
  }, selector);
}

test("placeholder text meets the 4.5:1 contrast bar", async ({ page }) => {
  await blockChessCom(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Chess.com username" })).toBeVisible();
  const loginRatio = await placeholderContrast(page, "#username");
  expect(loginRatio).toBeGreaterThanOrEqual(4.5);

  await signIn(page);
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search games" })).toBeVisible();
  const gamesRatio = await placeholderContrast(page, 'input[type="search"]');
  expect(gamesRatio).toBeGreaterThanOrEqual(4.5);
});

test("small screens keep 32px tap targets on the brand, rows and examples", async ({ page, request }) => {
  await blockChessCom(page);
  await signIn(page);
  const games = (await (await request.get(`/api/games?username=${player}`)).json()) as GameSummary[];
  const game = games.find((candidate) => candidate.analyzed)!;

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/#/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  const brand = await page.locator("header a").first().boundingBox();
  expect(brand).not.toBeNull();
  expect(brand!.height).toBeGreaterThanOrEqual(31.5);
  const row = await page.locator('[data-testid^="game-"]').first().boundingBox();
  expect(row).not.toBeNull();
  expect(row!.height).toBeGreaterThanOrEqual(31.5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/game/${game.uuid}?ply=20`);
  await expect(page.getByRole("region", { name: "Next move" })).toBeVisible({ timeout: 15000 });
  const engineLines = page.locator("summary").filter({ hasText: "Engine lines" });
  const engineDetails = page.locator("details").filter({ has: engineLines });
  const engineBox = await engineLines.boundingBox();
  await engineLines.click();
  await expect(engineDetails).toHaveAttribute("open", "");

  await page.goto("/#/style");
  await expect(page.getByTestId("trait-row").first()).toBeVisible();
  const example = await page.getByTestId("trait-row").first().getByRole("link").first().boundingBox();
  expect(example).not.toBeNull();
  expect(example!.height).toBeGreaterThanOrEqual(31.5);
  const measuredSummary = page.locator("summary").filter({ hasText: "How this is measured" });
  const measuredDetails = page.locator("details").filter({ has: measuredSummary });
  const measuredBox = await measuredSummary.boundingBox();
  await measuredSummary.click();
  await expect(measuredDetails).toHaveAttribute("open", "");

  expect(engineBox).not.toBeNull();
  expect(engineBox!.height).toBeGreaterThanOrEqual(32);
  expect(measuredBox).not.toBeNull();
  expect(measuredBox!.height).toBeGreaterThanOrEqual(32);
});
