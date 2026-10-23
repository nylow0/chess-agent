import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const realDb = path.join(root, "data", "chess.db");
const snapshotDir = path.join(root, ".artifacts", "e2e");
const snapshot = path.join(snapshotDir, "chess.db");

if (!(await Bun.file(realDb).exists())) {
  console.error(
    "No database at data/chess.db. Sign in and analyze some games first; " +
      "the end-to-end tests run against a copy of your real games.",
  );
  process.exit(1);
}

// The tests exercise the same server that `bun run start` serves, so build the
// web app first. Its output is inherited so a failing build shows the reason.
const build = Bun.spawnSync(["bun", "--cwd", "apps/web", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error(`Web build failed (exit code ${build.exitCode ?? "signal"}).`);
  process.exit(1);
}

mkdirSync(snapshotDir, { recursive: true });
// A stale write-ahead log beside the snapshot would replay onto the fresh bytes.
rmSync(`${snapshot}-wal`, { force: true });
rmSync(`${snapshot}-shm`, { force: true });

// Read-only so the player's live database is never touched, and serialize()
// yields a consistent image even while a dev server holds the WAL.
const source = new Database(realDb, { readonly: true });
const bytes = source.serialize();
source.close();
await Bun.write(snapshot, bytes);

// index.ts reads both at import time, so set them before the dynamic import.
process.env.CHESS_DB_PATH = snapshot;
process.env.PORT = "3210";
await import("../apps/server/src/index.ts");
