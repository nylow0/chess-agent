import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const dbPath = process.env.CHESS_DB_PATH ?? path.resolve(import.meta.dir, "../../../data/chess.db");
if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");

db.run(`
  CREATE TABLE IF NOT EXISTS games (
    uuid TEXT PRIMARY KEY,
    pgn TEXT,
    url TEXT,
    time_control TEXT,
    time_class TEXT,
    rated INTEGER,
    end_time INTEGER,
    white_username TEXT,
    white_rating INTEGER,
    white_result TEXT,
    black_username TEXT,
    black_rating INTEGER,
    black_result TEXT,
    opening TEXT,
    analyzed INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS analyses (
    game_uuid TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    engine_name TEXT,
    engine_version TEXT,
    depth INTEGER,
    multi_pv INTEGER,
    data TEXT,
    error TEXT,
    updated_at INTEGER
  )
`);

export function resetRunningAnalyses(): void {
  db.run("UPDATE analyses SET status = 'pending' WHERE status = 'running'");
}

/** Stored-summary schema version. Bump when computeSummary output changes shape or meaning. */
export const SUMMARY_VERSION = 7;

const analysisColumns = db.query<{ name: string }, []>("PRAGMA table_info(analyses)").all();
const addAnalysisColumn = (name: string, definition: string): void => {
  if (!analysisColumns.some((column) => column.name === name)) {
    db.run(`ALTER TABLE analyses ADD COLUMN ${definition}`);
  }
};
addAnalysisColumn("username", "username TEXT");
// Summary columns let the list/profile endpoints skip parsing every analysis blob.
addAnalysisColumn("my_accuracy", "my_accuracy REAL");
addAnalysisColumn("my_cpl", "my_cpl REAL");
addAnalysisColumn("my_counts", "my_counts TEXT");
addAnalysisColumn("summary_version", "summary_version INTEGER NOT NULL DEFAULT 0");
db.run(`CREATE TABLE IF NOT EXISTS position_evals (
  cache_key TEXT PRIMARY KEY, data TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS decisions (
  username TEXT NOT NULL COLLATE NOCASE, game_uuid TEXT NOT NULL, ply INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (username, game_uuid, ply)
)`);
db.run(`CREATE INDEX IF NOT EXISTS analysis_queue ON analyses(status, updated_at)`);

export interface GameRow {
  uuid: string;
  pgn: string;
  url: string;
  time_control: string;
  time_class: string;
  rated: number;
  end_time: number;
  white_username: string;
  white_rating: number;
  white_result: string;
  black_username: string;
  black_rating: number;
  black_result: string;
  opening: string | null;
  analyzed: number;
}

export interface GameRowWithAnalysis extends GameRow {
  analysis_status: string | null;
  analysis_username: string | null;
  my_accuracy: number | null;
  my_cpl: number | null;
  my_counts: string | null;
}

export interface AnalysisRow {
  game_uuid: string;
  status: string;
  engine_name: string | null;
  engine_version: string | null;
  depth: number | null;
  multi_pv: number | null;
  data: string | null;
  error: string | null;
  updated_at: number;
  username: string | null;
  my_accuracy: number | null;
  my_cpl: number | null;
  my_counts: string | null;
  summary_version: number;
}

export interface QueueCounts {
  pending: number;
  running: number;
  failed: number;
}

export function getGame(uuid: string): GameRow | null {
  return db.query("SELECT * FROM games WHERE uuid = ?").get(uuid) as GameRow | null;
}

export function getGamesForUser(username: string): GameRowWithAnalysis[] {
  return db
    .query(
      `SELECT g.*, a.status AS analysis_status, a.username AS analysis_username, a.my_accuracy, a.my_cpl, a.my_counts
       FROM games g LEFT JOIN analyses a ON a.game_uuid = g.uuid
       WHERE g.white_username = ? COLLATE NOCASE OR g.black_username = ? COLLATE NOCASE
       ORDER BY g.end_time DESC`
    )
    .all(username, username) as GameRowWithAnalysis[];
}

export function getAnalysis(uuid: string): AnalysisRow | null {
  return db.query("SELECT * FROM analyses WHERE game_uuid = ?").get(uuid) as AnalysisRow | null;
}

export function getQueueCounts(username: string): QueueCounts {
  const rows = db.query<{ status: string; n: number }, [string]>(
    "SELECT status, COUNT(*) n FROM analyses WHERE username = ? COLLATE NOCASE GROUP BY status"
  ).all(username);
  const counts: QueueCounts = { pending: 0, running: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "pending") counts.pending = row.n;
    else if (row.status === "running") counts.running = row.n;
    else if (row.status === "error") counts.failed = row.n;
  }
  return counts;
}
