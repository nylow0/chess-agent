import type { Page } from "@playwright/test";

// The e2e tests run against a copy of a real database, so they need a player in it.
const testPlayer = process.env.CHESS_TEST_PLAYER;
if (!testPlayer) throw new Error("Set CHESS_TEST_PLAYER to a username in data/chess.db");
export const player = testPlayer;

// The Games view skips its automatic sync while the stored timestamp is fresh.
export async function seedSync(page: Page, name: string = player): Promise<void> {
  await page.addInitScript((username) => {
    localStorage.setItem(`chess-last-sync:${username}`, String(Date.now()));
  }, name);
}

// Sign in through localStorage instead of the login form, and keep the quiet
// background sync out of the test.
export async function signIn(page: Page, name: string = player): Promise<void> {
  await page.addInitScript((username) => {
    localStorage.setItem("chess-username", username);
  }, name);
  await seedSync(page, name);
}

// The login form and the Games view both reach Chess.com through these
// endpoints. Answering them locally keeps the whole suite offline.
export async function blockChessCom(page: Page): Promise<void> {
  await page.route("**/api/login", (route) =>
    route.fulfill({ status: 200, json: { username: player } }),
  );
  await page.route("**/api/sync", (route) =>
    route.fulfill({ status: 200, json: { newGames: 0, totalGames: 0 } }),
  );
}
