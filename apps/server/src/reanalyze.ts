import type { GameAnalysis } from "@chess/shared";
import { db } from "./db";
import { engineMeta } from "./engine";
import { ANALYSIS_REVISION } from "./worker";

/** Cache keys for the current engine + analysis revision start with this prefix. */
const EVAL_KEY_PREFIX = `${engineMeta.version}:${ANALYSIS_REVISION}:`;

/**
 * Drop cached evaluations written before the current revision. The revision is
 * part of every key, so a prefix match keeps exactly the current entries.
 */
export function purgeStaleEvaluations(): { removed: number; kept: number } {
  const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM position_evals").get()?.n ?? 0;
  db.run("DELETE FROM position_evals WHERE substr(cache_key, 1, ?) != ?", [EVAL_KEY_PREFIX.length, EVAL_KEY_PREFIX]);
  const kept = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM position_evals").get()?.n ?? 0;
  return { removed: before - kept, kept };
}

function storedRevision(data: string | null): number | null {
  if (!data) return null;
  try {
    return (JSON.parse(data) as GameAnalysis).engine?.revision ?? null;
  } catch {
    return null;
  }
}

/**
 * Put every finished analysis that predates the current revision back into the
 * queue. Saved data and summary columns are kept, so a cancel restores the old
 * result. Returns how many games were queued and how many are already current.
 */
export function requeueOutdatedAnalyses(username?: string): { queued: number; current: number } {
  const rows = username
    ? db.query<{ game_uuid: string; status: string; data: string | null }, [string]>(
        "SELECT game_uuid, status, data FROM analyses WHERE username = ? COLLATE NOCASE"
      ).all(username)
    : db.query<{ game_uuid: string; status: string; data: string | null }, []>("SELECT game_uuid, status, data FROM analyses").all();
  let queued = 0;
  let current = 0;
  for (const row of rows) {
    if (storedRevision(row.data) === ANALYSIS_REVISION) {
      current += 1;
      continue;
    }
    if (row.status !== "done") continue;
    db.run("UPDATE analyses SET status = 'pending', error = NULL, updated_at = ? WHERE game_uuid = ?", [Date.now(), row.game_uuid]);
    queued += 1;
  }
  return { queued, current };
}

if (import.meta.main) {
  const username = process.argv[2];
  const purged = purgeStaleEvaluations();
  const { queued, current } = requeueOutdatedAnalyses(username);
  console.log(`Analysis revision ${ANALYSIS_REVISION}${username ? ` for ${username}` : ""}:`);
  console.log(`  cached evaluations removed: ${purged.removed} (current kept: ${purged.kept})`);
  console.log(`  games queued for re-analysis: ${queued}`);
  console.log(`  games already current: ${current}`);
}
