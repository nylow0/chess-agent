# Post-mortem

Post-mortem is a local tool for reviewing your own Chess.com games. It imports your games, analyzes them with the Reckless engine, and shows where each game was decided. It also learns which of several near-equal moves you tend to choose. It is for review only, and it does not provide a bot or help during live games. The package is named chess-analyst.

## Requirements

- Bun 1.3 or newer.
- Windows with AVX2 for the bundled engine. The Reckless 0.9 binary must be at `engine/reckless-windows-avx2.exe`. The path is fixed in `apps/server/src/engine.ts`, and the binary is not in Git.
- A public Chess.com username. No password is needed.

## Run it

Install dependencies and start the app.

```
bun install
bun run start
```

`bun run start` builds the web app and starts one server that serves both the API and the app at http://localhost:3000.

For development, start the API with reload and Vite together.

```
bun run dev
```

The app is then at http://localhost:5173. Vite proxies `/api` to the API on port 3000.

## Using it

**Sign in.** Enter a Chess.com username. Games are imported from archives for the current UTC calendar month and the five months before it. "Sync games" imports new games later using the same window. It also runs by itself when the Games screen opens and the last sync is more than 15 minutes old. "Import full history" imports everything.

**Games.** Search by opponent or opening, filter by time control and result, and sort by date, accuracy or blunder count. A summary above the list shows your record, win rate and average accuracy, and it follows the filters. "Analyze N new games" queues the games that have not been analyzed and are not already queued. A banner shows progress while games are queued, and "Stop" cancels the games still waiting. The game already being analyzed finishes.

**Review.** The evaluation graph shows the score through the game. "Move played" gives the verdict for the move that was played, the change in win chance, and the engine's preferred move. "Next move" shows the engine's choice, what was played, and a style suggestion when one is available. Buttons jump to your previous or next mistake, and the engine lines list the top candidates. Keyboard: Left and Right step one move, Home and End jump to the start and end, Up and Down jump between your mistakes, and F flips the board. The current position is kept in the URL, so a reload and the browser's Back button work.

**Style.** This screen shows whether your choices among near-equal moves are predictable enough to personalise suggestions. Two checks decide it: a gain of at least 2 points over the engine's top move, and a p-value below 0.05. With too few analyzed games, the screen says there is not enough data yet. Below the checks are your tendencies, each with example positions that link into the review.

## Settings

These environment variables configure the server and the Vite dev server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the server |
| `ANALYSIS_DEPTH` | `14` | Engine search depth, an integer from 1 to 30 |
| `ANALYSIS_WORKERS` | a quarter of the logical cores, clamped to 1-4 | Engine processes, each with 2 threads |
| `CHESS_DB_PATH` | `data/chess.db` | SQLite database file |
| `API_PORT` | `3000` | API port the Vite dev server proxies `/api` to |

## Data

All state lives in one SQLite file, `data/chess.db`, which is not in Git. Copy that file to back it up. On start the server upgrades older databases in place. It backfills summary columns, repairs history-dependent draws and move losses, rebuilds decisions and marks stored style profiles stale without running the engine again. The first start after an upgrade can take a few minutes while this one-time repair runs, and the app does not respond until it finishes. Analysis takes about 45 seconds per game per worker at depth 14 (roughly 0.8 seconds per position searched). Analyses made before the current analysis revision can be redone with `reanalyze.ts`.

## How moves are judged

Every evaluation is from White's point of view. A move's centipawn loss compares the engine's best score with the score of the move played. Scores beyond ±1000 centipawns, which are forced wins the engine reports as very large numbers, are capped at ±1000. That is the same value used for a forced mate, so one move can lose at most 2000.

Verdicts use the loss in win chance, not raw centipawns. Win chance is `100 / (1 + exp(-0.00368208 * cp))`. The engine's first choice is "best". A loss under 2 points is "excellent", under 5 "good", under 10 "inaccuracy", under 20 "mistake", and anything larger is "blunder".

Repetition draws use the PGN's move history only on the final ply. The resulting position and the played candidate are scored zero without a child search. After fallback capping, candidates are stably ranked by value for the mover. The best candidate sets the preferred move and pre-move evaluation, and the previous ply's post-move evaluation matches it. A winning alternative sets the loss for the repetition; when the draw ranks first, it stays "best" with zero loss. Position-only cached evaluations are kept intact.

Game accuracy measures position-to-position win-chance loss with a fitted curve, `100 / (1 + exp(-0.002 * cp))`, and a separate ±3000 cp limit for scores and mates. It rescales the average move accuracy with a small, capped adjustment for game length. Nested validation on the player's 44 reviewed games, holding out both sides together and tuning only on training games, gives an average error of 2.98 points against Chess.com. The main measured improvement comes from calibration and score handling. Chess.com's formula is private, and this small sample does not establish accuracy for other players or ratings. The per-move formula omits lila's +1 uncertainty bonus; verdicts keep their original curve.

Reckless 0.9 has no `go searchmoves` command. When the played move is not among the six engine lines, the adapter plays it on the board and searches the resulting position one depth less. It converts that score back to the side that moved, then caps it at the weakest of the six root scores, because the engine ranked the played move below all of them. Taking the weakest score also covers cases where rank and score disagree across search depths.

Every search first sends `ucinewgame` and waits for `readyok`. A reused Reckless process otherwise carries transposition and search state from earlier positions into the next search, which shifts the scores of a long-lived worker (so the app resets the engine before each position as well).

## How the style model works

The model uses decisions where the played move and at least one alternative are within 50 centipawns of the strongest candidate score, measured from the mover's point of view. This eligibility band uses the maximum score even when it differs from the engine's first-ranked candidate. Positions with a mate score are excluded. A decision counts only when it offers at least two such choices and includes the move played. The features describe trades, queens, blocked central pawns, open files, forcing moves, pawn advances toward the enemy king, king shelter, material at risk, activity, restriction, score spread, game phase, development and central control.

Games are split into five folds by sorted game id. Every game is held out once, and counts are pooled across folds. Feature scaling, preference weights and centipawn-scale tuning never use the held-out games. The final model trains on all eligible decisions. Training weights decay with a 182.625-day half-life, anchored to the latest training game. Held-out counts are unweighted.

The engine baseline in every held-out fold is its first-ranked candidate, `decision.candidates[0]`, even when another candidate has a higher score or the first candidate falls outside the eligibility band. The gate is an exact two-sided sign test on positions where only one of the model and that baseline was correct. The gain is the difference between the model's correct count and the engine's correct count, as a percentage of the held-out choices. The profile has three states: no signal, weak signal and confirmed. It is confirmed when the gain is at least 2 points and the p-value is below 0.05.

The profile is never trained inside a request. The server returns the stored profile and retrains it in a background process when new games have been analyzed, and when the analysis queue becomes empty.

Performance compares average centipawn loss on the player's next moves within 10 plies, within the same pre-move phase and evaluation bucket. Buckets are below -150 cp, -150 through +150 cp, and above +150 cp, from the mover's point of view. Each matched group needs 10 observations on both sides. A claim is shown only when its sign agrees in all five folds. These are descriptive associations, and their contribution to move prediction is not validated.

Recommendations use a tolerance from 0 to 100 centipawns, default 30, and are preference-only by default. Turning off preference-only enables an experimental combined score with 35% preference and 65% performance. Forced mate positions keep the engine's first choice.

Known limitation: fold assignment depends on the sorted list of game ids. Adding one game can move many games into a different fold, so the measured gain can change from one game to the next. Before the engine fix of 4 October 2026 this was enough to flip the verdict: 376 games gave 2.15 points (confirmed) and 377 games gave 1.14 points (weak signal). Those figures were measured on engine scores that drifted between searches. On the current data, measured against the engine's first-ranked move, the gain is 5.91 points over 5,231 choices from 379 games (p below 0.001), well clear of the gate.

## Tests and checks

| Command | What it does |
| --- | --- |
| `bun test` | Server unit tests. The test preload always uses an in-memory database. |
| `bun run typecheck` | Typechecks all workspaces. |
| `bun run build` | Builds the web app. |
| `bun run test:ui` | Playwright tests. Builds the web app, snapshots `data/chess.db` into `.artifacts/e2e/chess.db`, and runs against the app's own server on port 3210 serving that build. |

`bun run test:ui` starts with `bun tests/e2e-server.ts`. That script builds the web app, copies the real database to `.artifacts/e2e/chess.db`, points the server at the copy, and starts the app's own server on port 3210. The server serves both the API and the built app from `apps/web/dist`, so there is no Vite dev server and Playwright runs the tests against `http://localhost:3210`. Chess.com is never contacted: the login and sync endpoints are stubbed in the browser. Most tests sign in through localStorage, and the navigation test walks the login form. Set `CHESS_TEST_PLAYER` to a player in `data/chess.db`; the tests refuse to start without it. If `data/chess.db` does not exist, the API server exits and the tests cannot run.

Install the test browser once.

```
$env:PLAYWRIGHT_BROWSERS_PATH=".artifacts/browsers"
bunx playwright install chromium
```

## Command-line tools

Run these from the repository root. All of them read `CHESS_DB_PATH`.

| Command | Server | What it does |
| --- | --- | --- |
| `bun apps/server/src/batch.ts [username] [limit]` | Running on port 3000 | Syncs games and asks the server to queue up to `limit` unfinished games. Add `--all-history` to sync full history. |
| `bun apps/server/src/progress.ts` | Either | Prints analysis counts by status, decision counts, cache size and errors. |
| `bun apps/server/src/profile-report.ts <username>` | Either | Prints the style profile, or a summary with `--brief`, plus clock coverage. |
| `bun apps/server/src/refresh-features.ts` | Stopped | Repairs saved scores and summaries and rebuilds decision features and dates without an engine rerun. |
| `bun apps/server/src/reanalyze.ts [username]` | Stopped | Drops stale cached evaluations and queues every finished analysis made before the current analysis revision to be redone. Restarting the server mid-way resumes the queue; finished games stay done. |
| `bun apps/server/src/evaluate-style.ts <username>` | Stopped | Runs the five-fold evaluation and nested feature elimination, then saves the validated profile. Run after the analysis queue is empty. |
| `bun apps/server/src/audit-data.ts <username>` | Either | Checks saved analyses, decisions, recommendations and the profile. Add `--partial` to allow an incomplete backfill. |

## License

MIT, see `LICENSE`. The Alpha piece set in `apps/web/public/pieces/alpha/` is by Eric Bentzen under CC BY-SA 4.0.
