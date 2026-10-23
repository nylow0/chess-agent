// A separate process is essential here: an in-memory test cannot prove restart recovery.
export {};
if (process.env.CHESS_QUEUE_TEST !== "1") throw new Error("Test fixture only");
const { db } = await import("./db");
if (!db.query("SELECT uuid FROM games LIMIT 1").get()) {
  for (const uuid of ["queue-one", "queue-two"]) {
    db.run(`INSERT INTO games (uuid, pgn, white_username, black_username, time_control)
      VALUES (?, '1. f3 e5 2. g4 Qh4# 0-1', 'fixture', 'opponent', '600')`, [uuid]);
    db.run("INSERT INTO analyses (game_uuid, username, status, updated_at) VALUES (?, 'fixture', 'pending', ?)", [uuid, Date.now()]);
  }
}
await import("./index");
