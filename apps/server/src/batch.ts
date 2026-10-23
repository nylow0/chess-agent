// Run with `bun apps/server/src/batch.ts [username] [limit]`. The server owns the queue.
import { db } from "./db";
import { syncGames } from "./chesscom";

const owner = db.query<{ name: string }, []>(`SELECT name, COUNT(*) n FROM (
  SELECT white_username name FROM games UNION ALL SELECT black_username name FROM games
) GROUP BY name ORDER BY n DESC LIMIT 1`).get();
const username = process.argv[2] ?? owner?.name;
if (!username) throw new Error("Supply a player username");
const limit = Number(process.argv[3] ?? 5);
console.log("sync", username, await syncGames(username, process.argv.includes("--all-history")));
const games = db.query<{ uuid: string }, [string, string, number]>(`SELECT g.uuid FROM games g
  LEFT JOIN analyses a ON a.game_uuid = g.uuid
  WHERE (g.white_username = ? COLLATE NOCASE OR g.black_username = ? COLLATE NOCASE)
    AND (a.status IS NULL OR a.status != 'done' OR a.multi_pv != 6)
  ORDER BY g.end_time DESC LIMIT ?`).all(username, username, limit);
const response = await fetch("http://localhost:3000/api/analyze", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, gameUuids: games.map(game => game.uuid) }),
});
console.log(response.status, await response.json());
