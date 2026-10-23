import { db } from "./db";

const username = process.argv[2];
const expected = Number(process.argv[3]);
if (!username || !Number.isInteger(expected)) throw new Error("watch-history requires a username and the expected game count");
const deadline = Date.now() + 4 * 60 * 60 * 1000;
while (true) {
  const counts = db.query<{ status: string; n: number }, [string, string]>(`SELECT COALESCE(a.status, 'unqueued') status, COUNT(*) n
    FROM games g LEFT JOIN analyses a ON a.game_uuid = g.uuid
    WHERE g.white_username = ? COLLATE NOCASE OR g.black_username = ? COLLATE NOCASE GROUP BY status`).all(username, username);
  console.log(new Date().toISOString(), JSON.stringify(counts));
  if (counts.some(row => row.status === "error")) throw new Error("Analysis errors need attention before continuing.");
  if (counts.find(row => row.status === "done")?.n === expected && counts.every(row => row.status === "done")) break;
  if (Date.now() > deadline) throw new Error("History did not finish within four hours.");
  await Bun.sleep(55000);
}
console.log("HISTORY_COMPLETE. Run the full-data audit and evaluate-style.ts before deciding the gate.");
if (process.argv.includes("--evaluate")) {
  await import("./evaluate-style");
  await import("./audit-data");
  console.log("EVALUATION_AND_AUDIT_COMPLETE");
}
