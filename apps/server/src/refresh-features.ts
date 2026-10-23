import type { GameAnalysis } from "@chess/shared";
import { db, getGame } from "./db";
import { saveGameAnalysis } from "./worker";

// Re-extract features from saved engine lines without another engine backfill.
const analyses = db.query<{ game_uuid: string; username: string; data: string }, []>(
  "SELECT game_uuid, username, data FROM analyses WHERE status = 'done' AND username IS NOT NULL"
).all();
let count = 0;
for (const row of analyses) {
  const game = getGame(row.game_uuid);
  if (!game) continue;
  const analysis = JSON.parse(row.data) as GameAnalysis;
  count += saveGameAnalysis({ game, username: row.username, analysis, source: "feature-refresh" });
}
console.log(`Refreshed ${count} decisions across ${analyses.length} games`);
