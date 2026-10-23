// A separate process is essential: it proves the trainer follows the database
// path the parent assigned at runtime, while the launch-time path stays a throwaway file.
export {};
if (process.env.CHESS_TRAINER_TEST !== "1") throw new Error("Test fixture only");

const runtimeDbPath = process.argv[2];
const username = process.argv[3];
if (!runtimeDbPath || !username) throw new Error("trainer-fixture requires a runtime database path and a username");

// CHESS_DB_PATH was set at launch to a throwaway file; reassign it at runtime so
// the parent opens runtime.db. A trainer child without an explicit env only sees the launch value.
process.env.CHESS_DB_PATH = runtimeDbPath;

const { db, dbPath } = await import("./db");
if (dbPath !== runtimeDbPath) throw new Error(`fixture opened ${dbPath}, expected ${runtimeDbPath}`);
const { scheduleStyleTraining, trainingIdle } = await import("./style");

scheduleStyleTraining(username);
await trainingIdle();
// Close cleanly so the write-ahead log is checkpointed before the test reads the file.
db.close();
process.exit(0);
