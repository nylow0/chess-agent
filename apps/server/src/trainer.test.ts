import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dbPath } from "./db";
import { makeTrainSpawner, scheduleStyleTraining, trainerLaunch, trainingIdle } from "./style";

function profileRows(databasePath: string, username: string): number {
  if (!existsSync(databasePath)) return 0;
  const database = new Database(databasePath, { readonly: true });
  try {
    const table = database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'style_profiles'"
    ).get();
    if (!table) return 0;
    return database.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM style_profiles WHERE username = ?").get(username)?.n ?? 0;
  } finally {
    database.close();
  }
}

test("the trainer command and environment are pinned to the open database", () => {
  const launch = trainerLaunch("someone");
  expect(launch.env.CHESS_DB_PATH).toBe(dbPath);
  expect(launch.cmd.at(-1)).toBe("someone");
  expect(launch.cmd.at(-2)?.endsWith("train-profile.ts")).toBe(true);
});

test("trainer exits always release tracking, but only success retries stale results", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const code of [1, 0]) {
      const username = `exit-test-${code}`;
      let spawns = 0;
      let retries = 0;
      const spawner = makeTrainSpawner(() => {
        spawns++;
        return Bun.spawn([process.execPath, "-e", `process.exit(${code})`], { stdout: "ignore", stderr: "ignore" });
      }, () => { retries++; });
      scheduleStyleTraining(username, spawner);
      await trainingIdle();
      expect(spawns).toBe(1);
      expect(retries).toBe(code === 0 ? 1 : 0);
      if (code === 1) expect(errors).toHaveBeenCalledTimes(1);
      // The exit released the username, so an explicit later request can retry.
      scheduleStyleTraining(username, spawner);
      await trainingIdle();
      expect(spawns).toBe(2);
    }
  } finally { errors.mockRestore(); }
});

test("an in-memory database skips the real trainer but not an injected spawner", () => {
  expect(dbPath).toBe(":memory:");
  scheduleStyleTraining("nobody");
  let calls = 0;
  scheduleStyleTraining("nobody", () => { calls += 1; });
  expect(calls).toBe(1);
});

test("the trainer writes to the runtime database, not its launch database", async () => {
  const directory = path.resolve(import.meta.dir, "../../../.artifacts/trainer-tests", crypto.randomUUID());
  mkdirSync(directory, { recursive: true });
  const launchDb = path.join(directory, "launch.db");
  const runtimeDb = path.join(directory, "runtime.db");
  try {
    // The fixture only ever sees launchDb through its launch environment; the
    // trainer must reach runtimeDb, which the fixture assigns at runtime.
    const fixture = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "trainer-fixture.ts"), runtimeDb, "probe"],
      { env: { ...process.env, CHESS_DB_PATH: launchDb, CHESS_TRAINER_TEST: "1" }, stdout: "inherit", stderr: "inherit" }
    );
    expect(await fixture.exited).toBe(0);
    expect(profileRows(runtimeDb, "probe")).toBe(1);
    expect(profileRows(launchDb, "probe")).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
