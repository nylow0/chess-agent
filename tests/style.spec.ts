import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { StyleProfile, StyleTrait } from "../packages/shared/src";
import { traitCopy } from "../apps/web/src/lib/components/style/traitCopy";
import { blockChessCom, player, signIn } from "./helpers";

const USERNAME = player;

test.beforeEach(async ({ page }) => {
  await blockChessCom(page);
});

async function openStyle(page: Page): Promise<void> {
  await signIn(page);
  await page.goto("/#/style");
}

async function scrollToLastTrait(page: Page): Promise<number> {
  const lastRow = page.getByTestId("trait-row").last();
  await lastRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  return page.evaluate(() => window.scrollY);
}

async function realProfile(request: APIRequestContext): Promise<StyleProfile> {
  const response = await request.get(`/api/style/${USERNAME}`);
  return (await response.json()) as StyleProfile;
}

function tendencyTraits(profile: StyleProfile): StyleTrait[] {
  return profile.traits
    .filter((trait) => Math.abs(trait.preference) >= 0.08)
    .sort((a, b) => Math.abs(b.preference) - Math.abs(a.preference));
}

function traitName(trait: StyleTrait): string {
  return trait.preference >= 0 ? traitCopy[trait.feature].positive.name : traitCopy[trait.feature].negative.name;
}

test("real profile shows the right verdict, checks and tendencies", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const profile = await realProfile(request);

  await openStyle(page);

  const expectedPill =
    !profile.enoughData ? "Not enough games"
    : profile.status === "confirmed" ? "Confirmed"
    : profile.status === "weak_signal" ? "Weak signal"
    : "No signal";
  await expect(page.getByText(expectedPill, { exact: true })).toBeVisible();

  const expectedHeadline =
    !profile.enoughData ? "There are not enough analyzed games yet."
    : profile.status === "confirmed" ? "Your choices are predictable enough to personalise suggestions."
    : profile.status === "weak_signal" ? "There is a pattern in your choices, but it is not strong enough yet."
    : "No reliable pattern yet.";
  await expect(page.getByRole("heading", { name: expectedHeadline })).toBeVisible();

  const gainRow = page.getByRole("listitem").filter({ hasText: "Better than the engine's top move" });
  await expect(gainRow).toContainText(`${profile.gainPp.toFixed(2)} points`);
  await expect(gainRow.getByText(profile.gainPp >= 2 ? "Passed" : "Not passed", { exact: true })).toBeVisible();

  const pRow = page.getByRole("listitem").filter({ hasText: "Unlikely to be chance" });
  await expect(pRow).toContainText(profile.pValue < 0.001 ? "p < 0.001" : `p = ${profile.pValue.toFixed(3)}`);
  await expect(pRow.getByText(profile.pValue < 0.05 ? "Passed" : "Not passed", { exact: true })).toBeVisible();

  const expected = tendencyTraits(profile);
  await expect(page.getByTestId("trait-row")).toHaveCount(expected.length);
  if (expected.length > 0) {
    await expect(page.getByTestId("trait-row").first().getByRole("heading", { level: 3 })).toHaveText(
      traitName(expected[0]),
    );
  }

  await page.getByText("How this is measured", { exact: true }).click();
  const folds = page.getByRole("table", { name: "Validation folds" });
  await expect(folds).toBeVisible();
  await expect(folds.locator("tbody tr")).toHaveCount(5);

  expect(errors).toEqual([]);
});

test("example links open the game at the right position", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const profile = await realProfile(request);
  const trait = tendencyTraits(profile)[0];
  test.skip(!trait || trait.examples.length === 0, "the profile has no examples to open");
  const example = trait.examples[0];

  await openStyle(page);
  await page.getByRole("link", { name: `Review ${traitName(trait)} example 1` }).first().click();
  await expect.poll(() => page.url()).toContain(`#/game/${example.gameUuid}?ply=${example.ply}`);
  expect(page.url()).toContain("from=style");

  expect(errors).toEqual([]);
});

test("confirmed profile shows both checks as passed", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const real = await realProfile(request);
  await page.route("**/api/style/*", (route) =>
    route.fulfill({ json: { ...real, status: "confirmed", gainPp: 2.6, pValue: 0.004, updating: false } }),
  );

  await openStyle(page);
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  const gainRow = page.getByRole("listitem").filter({ hasText: "Better than the engine's top move" });
  await expect(gainRow.getByText("Passed", { exact: true })).toBeVisible();
  const pRow = page.getByRole("listitem").filter({ hasText: "Unlikely to be chance" });
  await expect(pRow.getByText("Passed", { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

test("updating profile shows the notice and polls again", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const real = await realProfile(request);
  await page.route("**/api/style/*", (route) => route.fulfill({ json: { ...real, updating: true } }));

  await openStyle(page);
  await expect(page.getByText("Updating with your newest games.", { exact: false })).toBeVisible();
  await page.waitForRequest((req) => req.url().includes("/api/style/"), { timeout: 7000 });

  expect(errors).toEqual([]);
});

test("empty profile points the player at their games", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const real = await realProfile(request);
  await page.route("**/api/style/*", (route) =>
    route.fulfill({
      json: { ...real, decisions: 0, traits: [], enoughData: false, updating: false, folds: [], ablations: [] },
    }),
  );

  await openStyle(page);
  await expect(page.getByText("Analyze some games first.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your games" })).toHaveAttribute("href", "#/games");
  await expect(page.getByRole("heading", { name: "Your tendencies" })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("phone layout has no horizontal overflow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await openStyle(page);
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  expect(errors).toEqual([]);
});

test("wide layout keeps example links on one row and the meter above its sentence", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const profile = await realProfile(request);
  const trait = tendencyTraits(profile)[0];
  test.skip(!trait || trait.examples.length === 0, "the profile has no example links");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStyle(page);

  const links = page.getByTestId("trait-row").first().getByRole("link");
  await expect(links).toHaveCount(trait.examples.length);
  const rows = await links.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().y)));
  expect(new Set(rows).size).toBe(1);

  const meter = page.getByRole("img", { name: /Gain .+ points of the 2 needed/ });
  const sentence = page.getByText("The engine's top move matched your move");
  const meterBox = await meter.boundingBox();
  const sentenceBox = await sentence.boundingBox();
  expect(meterBox).not.toBeNull();
  expect(sentenceBox).not.toBeNull();
  expect(meterBox!.y + meterBox!.height).toBeLessThan(sentenceBox!.y);

  expect(errors).toEqual([]);
});

test("phone layout keeps the gain value on one line", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await openStyle(page);

  const value = page.getByTestId("gain-value");
  await expect(value).toBeVisible();
  const box = await value.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(30);

  expect(errors).toEqual([]);
});

test("tendency strength bars share the same left edge and width", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const profile = await realProfile(request);
  const expected = tendencyTraits(profile);
  test.skip(expected.length === 0, "the profile has no tendencies");

  await page.setViewportSize({ width: 1440, height: 900 });
  await openStyle(page);

  const bars = page.getByRole("img", { name: /^Strength \d+ of 100$/ });
  await expect(bars).toHaveCount(expected.length);
  const boxes = await bars.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    }),
  );
  const first = boxes[0];
  for (const box of boxes) {
    expect(Math.abs(box.left - first.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - first.width)).toBeLessThanOrEqual(1);
  }

  expect(errors).toEqual([]);
});

test("the Your style link restores the Style scroll position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStyle(page);
  await expect(page.getByTestId("trait-row").first()).toBeVisible();

  const before = await scrollToLastTrait(page);
  expect(before).toBeGreaterThan(100);

  await page.getByTestId("trait-row").last().getByRole("link").first().click();
  await expect(page.getByRole("region", { name: "Next move" })).toBeVisible({ timeout: 15000 });

  await page.getByRole("link", { name: /Your style/ }).click();
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: "Style scroll restored" })
    .toBeGreaterThan(before - 20);

  expect(errors).toEqual([]);
});

test("browser Back restores the Style scroll position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStyle(page);
  await expect(page.getByTestId("trait-row").first()).toBeVisible();

  const before = await scrollToLastTrait(page);
  expect(before).toBeGreaterThan(100);

  await page.getByTestId("trait-row").last().getByRole("link").first().click();
  await expect(page.getByRole("region", { name: "Next move" })).toBeVisible({ timeout: 15000 });

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your style", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { message: "Style scroll restored after Back" })
    .toBeGreaterThan(before - 20);

  expect(errors).toEqual([]);
});

test("example links label the correct move number and side", async ({ page, request }) => {
  const profile = await realProfile(request);
  const traits = tendencyTraits(profile).filter((trait) => trait.examples.length > 0);
  test.skip(traits.length === 0, "the profile has no examples");

  await openStyle(page);
  const rows = page.getByTestId("trait-row");
  for (let traitIndex = 0; traitIndex < traits.length; traitIndex++) {
    const trait = traits[traitIndex];
    for (let exampleIndex = 0; exampleIndex < trait.examples.length; exampleIndex++) {
      const example = trait.examples[exampleIndex];
      // The example's ply is the number of half-moves before the example move,
      // so moves[example.ply] in the game detail is that move.
      const detailResponse = await request.get(`/api/games/${example.gameUuid}`);
      const detail = (await detailResponse.json()) as { moves: string[] };
      expect(detail.moves[example.ply]).toBe(example.san);
      const expected = `${Math.floor(example.ply / 2) + 1}${example.ply % 2 === 0 ? "." : "..."} ${example.san}`;
      const link = rows
        .nth(traitIndex)
        .getByRole("link", { name: `Review ${traitName(trait)} example ${exampleIndex + 1}` });
      await expect(link).toHaveText(expected);
    }
  }
});
