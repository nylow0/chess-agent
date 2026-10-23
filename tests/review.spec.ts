import { expect, test } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";
import type { GameSummary, GameAnalysis, Recommendation } from "../packages/shared/src";
import { blockChessCom, player, signIn } from "./helpers";

const username = player;

test.beforeEach(async ({ page }) => {
  await blockChessCom(page);
});

const LABELS: Record<string, string> = {
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  book: "Book",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

const NOTABLE = ["inaccuracy", "mistake", "blunder"];

async function fetchGames(request: APIRequestContext): Promise<GameSummary[]> {
  const gamesResponse = await request.get(`/api/games?username=${username}`);
  return (await gamesResponse.json()) as GameSummary[];
}

// Chooses by property (an analyzed game where the player has at least one
// notable move) so adding games to the data cannot change which one is tested.
async function analyzedGameWithMistake(request: APIRequestContext) {
  const games = await fetchGames(request);
  const game = games.find((candidate) => {
    const counts = candidate.myCounts;
    return (
      candidate.analyzed &&
      !!counts &&
      counts.inaccuracy + counts.mistake + counts.blunder > 0
    );
  });
  if (!game) return null;
  const analysisResponse = await request.get(`/api/analysis/${game.uuid}`);
  const { analysis } = (await analysisResponse.json()) as { analysis?: GameAnalysis };
  if (!analysis) return null;
  return { game, analysis };
}

// The shortest analyzed game with at least `minPlies` plies.
async function analyzedGameWithPlies(request: APIRequestContext, minPlies: number) {
  const games = await fetchGames(request);
  for (const game of games) {
    if (!game.analyzed) continue;
    const response = await request.get(`/api/analysis/${game.uuid}`);
    const { analysis } = (await response.json()) as { analysis?: GameAnalysis };
    if (analysis && analysis.moves.length >= minPlies) return { game, analysis };
  }
  return null;
}

// Signs in through localStorage, opens an analyzed game and loads its analysis
// so every expectation is derived from the real data instead of hard-coded.
async function openGame(page: Page, request: APIRequestContext, ply?: number) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const found = await analyzedGameWithMistake(request);
  expect(found).not.toBeNull();
  const { game, analysis } = found!;

  await signIn(page);
  const suffix = ply && ply > 0 ? `?ply=${ply}` : "";
  await page.goto(`/#/game/${game.uuid}${suffix}`);

  return { errors, game, analysis };
}

function iAmWhite(game: GameSummary): boolean {
  return game.white.username.toLowerCase() === username.toLowerCase();
}

// Waits until the move marked as current sits fully inside the move-list's
// scroll container — the real clipping container for the move list on desktop
// (the panel's `.sec-movelist`, which itself clips on short windows) — with
// the 8px breathing room the list is expected to keep.
async function expectCurrentMoveInView(page: Page) {
  const list = page.getByLabel("Moves");
  const current = list.locator("[data-current='true']");
  await expect(current).toHaveCount(1);
  const zone = page.locator("[data-movelist-scroll]");
  await expect
    .poll(async () => {
      const zoneBox = await zone.boundingBox();
      const currentBox = await current.boundingBox();
      if (!zoneBox || !currentBox) return false;
      const above = currentBox.y - zoneBox.y;
      const below = zoneBox.y + zoneBox.height - (currentBox.y + currentBox.height);
      return above >= 8 && below >= 8;
    })
    .toBe(true);
}

// Finds an analyzed game whose last move delivered checkmate (mateAfter === 0).
async function findCheckmateGame(request: APIRequestContext) {
  const gamesResponse = await request.get(`/api/games?username=${username}`);
  const games = (await gamesResponse.json()) as GameSummary[];
  for (const candidate of games.filter((game) => game.analyzed)) {
    const response = await request.get(`/api/analysis/${candidate.uuid}`);
    const { analysis } = (await response.json()) as { analysis?: GameAnalysis };
    if (!analysis || analysis.moves.length === 0) continue;
    const last = analysis.moves[analysis.moves.length - 1];
    if (last.mateAfter === 0) return { game: candidate, analysis };
  }
  return null;
}

test("stepping through a game updates the board, panel and engine lines", async ({
  page,
  request,
}) => {
  const { errors, analysis } = await openGame(page, request);
  const total = analysis.moves.length;

  await expect(page.locator("cg-board piece")).toHaveCount(32);
  await expect(page.locator("[role=img][aria-label^='Chess board, move']")).toBeVisible();
  await expect(page.locator("svg.cg-shapes")).toHaveAttribute("aria-hidden", "true");

  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await expect(page.getByText(`1 / ${total}`, { exact: true })).toBeVisible();

  const first = analysis.moves[0];
  const played = page.getByRole("region", { name: "Move played" });
  await expect(played).toContainText(first.san);
  await expect(played).toContainText(LABELS[first.classification]);

  const second = analysis.moves[1];
  const enginePanel = page.locator("details").filter({ hasText: "Engine lines" });
  await expect(enginePanel).not.toHaveAttribute("open", "");
  await enginePanel.locator("summary").click();
  await expect(enginePanel).toHaveAttribute("open", "");
  // Match the button whose first move is exactly the line's SAN: the SAN can
  // also appear inside another line's PV, so a substring match is ambiguous.
  await expect(
    enginePanel
      .getByRole("button")
      .filter({ has: page.getByText(second.lines[0].san, { exact: true }) }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Last move", exact: true }).click();
  await expect(page.getByText("No engine lines for this position.")).toBeVisible();
  await expect(page.locator("svg.cg-shapes line")).toHaveCount(0);

  await page.getByRole("button", { name: "First move", exact: true }).click();
  // The review auto-orients to the player's colour, so the class after a flip
  // depends on the game; what must hold is that flipping toggles orientation.
  const wrap = page.locator(".cg-wrap").first();
  const blackBefore = (await wrap.getAttribute("class"))?.includes("orientation-black") ?? false;
  await page.getByRole("button", { name: "Flip board", exact: true }).click();
  await expect(page.locator(".orientation-black")).toHaveCount(blackBefore ? 0 : 1);

  // The open/closed choice survives a reload.
  await page.reload();
  await expect(
    page.locator("details").filter({ hasText: "Engine lines" }),
  ).toHaveAttribute("open", "");

  expect(errors).toEqual([]);
});

test("mistake navigation jumps to my graded moves and back", async ({ page, request }) => {
  const { errors, game, analysis } = await openGame(page, request);
  const total = analysis.moves.length;
  const mine = iAmWhite(game);

  const firstBad = analysis.moves.find(
    (move) => NOTABLE.includes(move.classification) && (move.ply % 2 === 1) === mine,
  );
  expect(firstBad).toBeDefined();

  await page.getByRole("button", { name: "Next mistake", exact: true }).click();
  await expect(page.getByText(`${firstBad!.ply} / ${total}`, { exact: true })).toBeVisible();

  const played = page.getByRole("region", { name: "Move played" });
  await expect(played).toContainText(LABELS[firstBad!.classification]);
  await expect(played).toContainText(`The engine preferred ${firstBad!.bestMoveSan}`);

  await page.getByRole("button", { name: "Show that position", exact: true }).click();
  await expect(page.getByText(`${firstBad!.ply - 1} / ${total}`, { exact: true })).toBeVisible();

  // The keyboard shortcut from the start does the same jump.
  await page.getByRole("button", { name: "First move", exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByText(`${firstBad!.ply} / ${total}`, { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

test("the evaluation graph jumps to the clicked position", async ({ page, request }) => {
  const { errors, analysis } = await openGame(page, request);
  const total = analysis.moves.length;

  const timeline = page.getByRole("slider", { name: "Game timeline" });
  await expect(timeline).toHaveAttribute("aria-valuetext", "Start position");
  const box = await timeline.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  const now = Number(await timeline.getAttribute("aria-valuenow"));
  expect(Math.abs(now - total / 2)).toBeLessThanOrEqual(2);
  await expect(page.getByText(`${now} / ${total}`, { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

test("the move list never marks a move as brilliant", async ({ page, request }) => {
  const { errors } = await openGame(page, request);

  const moveList = page.getByLabel("Moves");
  await expect(moveList).toBeVisible();
  expect(await moveList.textContent()).not.toContain("!!");

  expect(errors).toEqual([]);
});

test("the move list keeps the current move fully in view", async ({ page, request }) => {
  const { errors, game, analysis } = await openGame(page, request);
  const total = analysis.moves.length;

  await page.goto(`/#/game/${game.uuid}?ply=${Math.floor(total / 2)}`);
  await page.reload();
  await expectCurrentMoveInView(page);

  await page.goto(`/#/game/${game.uuid}?ply=${total}`);
  await page.reload();
  await expectCurrentMoveInView(page);

  expect(errors).toEqual([]);
});

test("the summary counts use the right plural", async ({ page, request }) => {
  const { errors, analysis } = await openGame(page, request);
  const counts = analysis.summary.counts;
  const order = [
    { kind: "blunder" as const, one: "blunder", many: "blunders" },
    { kind: "mistake" as const, one: "mistake", many: "mistakes" },
    { kind: "inaccuracy" as const, one: "inaccuracy", many: "inaccuracies" },
  ];
  const parts = order
    .filter((item) => (counts[item.kind] ?? 0) > 0)
    .map((item) => {
      const count = counts[item.kind] ?? 0;
      return `${count} ${count === 1 ? item.one : item.many}`;
    });
  const expected = parts.length > 0 ? parts.join(", ") : "No mistakes";

  await expect(page.locator("[data-summary]")).toHaveText(expected);

  expect(errors).toEqual([]);
});

test("a game ending in checkmate names the winner in the evaluation label", async ({
  page,
  request,
}) => {
  const mate = await findCheckmateGame(request);
  test.skip(mate === null, "no checkmate game in the data");
  const { game, analysis } = mate!;
  const last = analysis.moves[analysis.moves.length - 1];
  const expected = (last.cpAfter ?? 0) > 0 ? "1-0" : "0-1";

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto(`/#/game/${game.uuid}?ply=${analysis.moves.length}`);

  await expect(page.locator("[data-eval-label]")).toHaveText(expected);

  expect(errors).toEqual([]);
});

test("the controls sit inside the review panel and the review does not scroll", async ({
  page,
  request,
}) => {
  const { errors } = await openGame(page, request);

  const board = page.locator("cg-board");
  const controls = page.locator("[data-controls]");
  const panel = page.locator("aside.panel");
  await expect(board).toBeVisible();
  await expect(controls).toBeVisible();
  const panelBox = await panel.boundingBox();
  const controlsBox = await controls.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  // The controls are part of the review panel, spanning its width at the
  // bottom, rather than sitting under the board.
  expect(controlsBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(controlsBox!.x + controlsBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
  expect(controlsBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
  expect(
    controlsBox!.y + controlsBox!.height,
  ).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);

  expect(errors).toEqual([]);
});

test("the style row matches the recommendation endpoint", async ({ page, request }) => {
  const { errors, game, analysis } = await openGame(page, request);
  const mine = iAmWhite(game);

  const myTurn = analysis.moves.find((move) => (move.ply % 2 === 1) === mine);
  expect(myTurn).toBeDefined();
  if (myTurn!.ply > 1) {
    await page.goto(`/#/game/${game.uuid}?ply=${myTurn!.ply - 1}`);
  }

  const response = await request.get(
    `/api/recommend/${game.uuid}/${myTurn!.ply}?username=${username}&tolerance=30&mode=preference`,
  );
  const recommendation = (await response.json()) as Recommendation;

  const nextSection = page.getByRole("region", { name: "Next move" });
  if (recommendation.forYou) {
    await expect(nextSection).toContainText(recommendation.forYou.san);
  } else {
    await expect(nextSection).toContainText(recommendation.reason);
    await expect(nextSection.getByRole("link", { name: "About your style" })).toBeVisible();
  }

  expect(errors).toEqual([]);
});

test("the review fits a phone without horizontal overflow", async ({ page, request }) => {
  const { errors } = await openGame(page, request);

  await page.setViewportSize({ width: 390, height: 844 });
  const board = await page.locator("cg-board").boundingBox();
  expect(board).not.toBeNull();
  expect(board!.width).toBeGreaterThanOrEqual(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // Every file letter sits inside the board, not in a gutter beside it.
  const files = page.locator("coords.files coord");
  await expect(files).toHaveCount(8);
  const fileBoxes = await files.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }),
  );
  const boardBox = board!;
  for (const box of fileBoxes) {
    expect(box.left).toBeGreaterThanOrEqual(boardBox.x - 0.5);
    expect(box.top).toBeGreaterThanOrEqual(boardBox.y - 0.5);
    expect(box.right).toBeLessThanOrEqual(boardBox.x + boardBox.width + 0.5);
    expect(box.bottom).toBeLessThanOrEqual(boardBox.y + boardBox.height + 0.5);
  }

  await expect(page.getByRole("button", { name: "Next move", exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

// --- QA regressions on the review screen ---

test("review: a failed analysis request shows an error with a working retry", async ({
  page,
  request,
}) => {
  const found = await analyzedGameWithMistake(request);
  expect(found).not.toBeNull();
  test.skip((found?.analysis.moves.length ?? 0) < 21, "needs a game long enough for ply 20");
  const { game, analysis } = found!;
  const total = analysis.moves.length;

  await page.route("**/api/analysis/*", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await signIn(page);
  await page.goto(`/#/game/${game.uuid}?ply=20`);
  await expect(page.getByText(`20 / ${total}`, { exact: true })).toBeVisible();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("boom");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Loading analysis")).toHaveCount(0);

  // Retry works: the next response is the real analysis.
  await page.unroute("**/api/analysis/*");
  await page.route("**/api/analysis/*", (route) =>
    route.fulfill({ status: 200, json: { status: "done", analysis } }),
  );
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Move played" })).toContainText(
    analysis.moves[19].san,
  );
});

test("review: a failed analysis request on an unanalyzed game also shows a retry", async ({
  page,
}) => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const detail = {
    uuid,
    chessComId: uuid,
    timeControl: "600",
    timeClass: "rapid",
    rated: true,
    playedAt: Date.now(),
    white: { username, rating: 1500, result: "win" },
    black: { username: "opponent", rating: 1500, result: "loss" },
    analyzed: false,
    pgn: "",
    moves: ["e4", "e5"],
    fens: [startFen, startFen, startFen],
  };
  await page.route(new RegExp(`/api/games/${uuid}`), (route) =>
    route.fulfill({ status: 200, json: detail }),
  );
  await page.route("**/api/analysis/*", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await signIn(page);
  await page.goto(`/#/game/${uuid}`);

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("boom");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Loading analysis")).toHaveCount(0);
});

test("review: adjusting the style tolerance keeps the Adjust panel and focus", async ({
  page,
  request,
}) => {
  const found = await analyzedGameWithMistake(request);
  expect(found).not.toBeNull();
  const { game, analysis } = found!;
  const mine = iAmWhite(game);
  const myMove = analysis.moves.find((move) => (move.ply % 2 === 1) === mine);
  expect(myMove).toBeDefined();

  const seen: string[] = [];
  await page.route("**/api/recommend/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url.search);
    const tolerance = url.searchParams.get("tolerance");
    const mode = url.searchParams.get("mode");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        engineBest: null,
        forYou: {
          uci: "e2e4",
          san: `e4-${tolerance}-${mode}`,
          cp: 20,
          mate: null,
          pv: [],
          features: {},
          value: 20,
        },
        reason: `echo tolerance=${tolerance} mode=${mode}`,
        tolerance: Number(tolerance),
      }),
    });
  });

  await signIn(page);
  await page.goto(`/#/game/${game.uuid}?ply=${myMove!.ply - 1}`);
  const next = page.getByRole("region", { name: "Next move" });
  await expect(next.getByText("Your style")).toBeVisible();

  const adjust = next.locator("details");
  await adjust.locator("summary").click();
  await expect(adjust).toHaveAttribute("open", "");
  const slider = next.getByRole("slider", { name: "Style tolerance" });
  await slider.focus();

  // ArrowRight cannot move the board here; it changes the tolerance.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");

  await expect(adjust).toHaveAttribute("open", "");
  await expect(slider).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
    "Style tolerance",
  );
  await expect(next).toContainText("echo tolerance=55 mode=preference");
  await expect(next).toContainText("e4-55-preference");

  // The preference-only checkbox keeps the panel open too.
  await next.getByRole("checkbox", { name: "Preference only" }).click();
  await expect(adjust).toHaveAttribute("open", "");
  await expect(next).toContainText("echo tolerance=55 mode=combined");
  expect(seen.some((search) => search.includes("mode=combined"))).toBe(true);
});

test("review: stepping to another ply clears the previous suggestion immediately", async ({
  page,
  request,
}) => {
  const found = await analyzedGameWithMistake(request);
  expect(found).not.toBeNull();
  const { game, analysis } = found!;
  const mine = iAmWhite(game);
  const startPly = mine ? 0 : 1;
  const firstPly = startPly + 1;
  const secondPly = firstPly + 2;
  // The move plies are one ahead of the position the panel is fetched from.
  const secondPosition = secondPly - 1;
  test.skip(analysis.moves.length < secondPly, "needs two of the player's moves");
  const total = analysis.moves.length;

  await page.route("**/api/recommend/**", async (route) => {
    const url = new URL(route.request().url());
    const ply = Number(url.pathname.split("/").pop());
    const old = ply === firstPly;
    await new Promise((resolve) => setTimeout(resolve, old ? 3000 : 200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        engineBest: null,
        forYou: {
          uci: "e2e4",
          san: old ? "STAKE-OLD" : "STAKE-NEW",
          cp: 20,
          mate: null,
          pv: [],
          features: {},
          value: 20,
        },
        reason: old ? "old" : "new",
        tolerance: 30,
      }),
    });
  });

  await signIn(page);
  await page.goto(`/#/game/${game.uuid}?ply=${startPly}`);
  const next = page.getByRole("region", { name: "Next move" });
  await expect(next).toContainText("STAKE-OLD");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(`${secondPosition} / ${total}`, { exact: true })).toBeVisible();
  await expect(next).not.toContainText("STAKE-OLD");
  await expect(next).toContainText("STAKE-NEW");
  // The slow first response must never overwrite the newer ply's answer.
  await page.waitForTimeout(3200);
  await expect(next).toContainText("STAKE-NEW");
  await expect(next).not.toContainText("STAKE-OLD");
});

test("review: changing the ply hash in place moves the board, and Back/Forward follow", async ({
  page,
  request,
}) => {
  const found = await analyzedGameWithPlies(request, 40);
  test.skip(found === null, "no analyzed game with 40+ plies");
  const { game, analysis } = found!;
  const total = analysis.moves.length;
  const target = 40;

  await signIn(page);
  await page.goto(`/#/game/${game.uuid}?ply=0`);
  await expect(page.getByText(`0 / ${total}`, { exact: true })).toBeVisible();

  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#/game/${game.uuid}?ply=${target}`);
  await expect(page.getByText(`${target} / ${total}`, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByText(`0 / ${total}`, { exact: true })).toBeVisible();

  await page.goForward();
  await expect(page.getByText(`${target} / ${total}`, { exact: true })).toBeVisible();

  // Stepping still works after a URL jump.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(`${target + 1} / ${total}`, { exact: true })).toBeVisible();
});

test("review: a long opponent name and opening do not force a horizontal scroll", async ({
  page,
}) => {
  const uuid = "33333333-3333-4333-8333-333333333333";
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const moves = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "e4" : "e5"));
  const opponent = "b".repeat(40);
  const opening = "o".repeat(120);
  const detail = {
    uuid,
    chessComId: uuid,
    timeControl: "600",
    timeClass: "rapid",
    rated: true,
    playedAt: Date.now(),
    white: { username, rating: 1500, result: "win" },
    black: { username: opponent, rating: 1500, result: "loss" },
    opening,
    analyzed: false,
    pgn: "",
    moves,
    fens: [startFen],
  };
  await page.route(new RegExp(`/api/games/${uuid}`), (route) =>
    route.fulfill({ status: 200, json: detail }),
  );
  await page.route("**/api/analysis/*", (route) =>
    route.fulfill({ status: 404, json: { error: "no analysis" } }),
  );
  await signIn(page);

  for (const width of [390, 430, 768]) {
    await page.setViewportSize({ width, height: width >= 768 ? 1024 : 844 });
    await page.goto(`/#/game/${uuid}?ply=0`);
    await page.reload();
    // The players line is the review screen's single h1, and both long strings show.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(opponent);
    await expect(page.getByText(opening)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }

  await page.setViewportSize({ width: 360, height: 844 });
  await page.goto(`/#/game/${uuid}?ply=0`);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(opponent);
  await expect(page.getByText(opening)).toBeVisible();
  const narrow = await page.evaluate(() => {
    const h1 = document.querySelector("h1")!;
    const header = h1.closest("header")!;
    const doc = document.documentElement;
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      headerRight: header.getBoundingClientRect().right,
      h1Right: h1.getBoundingClientRect().right,
      clientWidth: doc.clientWidth,
    };
  });
  expect(narrow.headerRight, "review header past the viewport").toBeLessThanOrEqual(
    narrow.clientWidth,
  );
  expect(narrow.h1Right, "players line past the viewport").toBeLessThanOrEqual(narrow.clientWidth);
  expect(narrow.overflow, "page overflow at 360px").toBeLessThanOrEqual(0);
});

test("review: the engine-lines open choice survives an immediate reload", async ({
  page,
  request,
}) => {
  const { errors } = await openGame(page, request);
  const panel = page.locator("details").filter({ hasText: "Engine lines" });
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");

  // No pause: the choice must already be persisted by the toggle handler.
  await page.reload();
  await expect(
    page.locator("details").filter({ hasText: "Engine lines" }),
  ).toHaveAttribute("open", "");

  expect(errors).toEqual([]);
});

test("an unanalyzed game explains itself without console errors", async ({ page, request }) => {
  const games = await fetchGames(request);
  const game = games.find((candidate) => candidate.analyzed);
  expect(game).toBeDefined();
  const uuid = game!.uuid;

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // The real game body, but reported as never analyzed, and the analysis route
  // answers the new "unanalyzed" contract instead of a 404.
  await page.route(new RegExp(`/api/games/${uuid}(?:\\?|$)`), async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...detail, analyzed: false } });
  });
  await page.route(new RegExp(`/api/analysis/${uuid}(?:\\?|$)`), (route) =>
    route.fulfill({ status: 200, json: { status: "unanalyzed" } }),
  );

  await signIn(page);
  await page.goto(`/#/game/${uuid}?ply=0`);

  await expect(page.getByText("Not analyzed yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze this game" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
