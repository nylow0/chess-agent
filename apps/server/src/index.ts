import { resetRunningAnalyses } from "./db";
import { migrateSummaries, pump, shutdownEngine, workerCount } from "./worker";
import { killTraining } from "./style";
import routes from "./routes";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch: routes.fetch,
});

resetRunningAnalyses();
migrateSummaries();
pump();

console.log(`Post-mortem is running at http://localhost:${port}`);
console.log(`Analysis workers: ${workerCount}`);

process.on("uncaughtException", (err) => {
  console.error("FATAL uncaughtException:", err);
  shutdownEngine();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("FATAL unhandledRejection:", reason);
  shutdownEngine();
  process.exit(1);
});

process.on("exit", (code) => {
  console.error(`process exit: code=${code} at ${new Date().toISOString()}`);
});

process.on("SIGINT", () => {
  shutdownEngine();
  killTraining();
  server.stop(true);
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownEngine();
  killTraining();
  server.stop(true);
  process.exit(0);
});
