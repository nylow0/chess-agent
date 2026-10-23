import { db } from "./db";
console.log("analyses", db.query("SELECT status, count(*) n FROM analyses GROUP BY status").all());
console.log("decisions", db.query("SELECT username, count(*) n, count(DISTINCT game_uuid) games FROM decisions GROUP BY username").all());
console.log("cache", db.query("SELECT count(*) n FROM position_evals").get());
console.log("errors", db.query("SELECT game_uuid, error FROM analyses WHERE status = 'error'").all());
