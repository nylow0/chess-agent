import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdirSync } from "node:fs";

test("SQLite queue resumes after killing the actual server and rejects duplicate submissions", async () => {
  const dir = path.resolve(import.meta.dir, "../../../.artifacts/queue-tests");
  mkdirSync(dir, { recursive: true });
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port!;
  await listener.stop(true);
  const env = { ...process.env, CHESS_DB_PATH: path.join(dir, `${crypto.randomUUID()}.db`),
    CHESS_QUEUE_TEST: "1", ANALYSIS_DEPTH: "10", ANALYSIS_WORKERS: "1", PORT: String(port) };
  const launch = () => Bun.spawn([process.execPath, path.join(import.meta.dir, "queue-fixture.ts")], { env, stdout: "ignore", stderr: "ignore" });
  let server = launch();
  const stop = () => {
    if (server.exitCode === null) {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill("SIGTERM");
    }
  };
  const get = async () => {
    try { return await (await fetch(`http://localhost:${port}/api/analysis/queue-one`)).json() as { status: string }; }
    catch { return null; }
  };
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (await get())?.status !== "running") await Bun.sleep(20);
    expect((await get())?.status).toBe("running");
    const duplicate = await fetch(`http://localhost:${port}/api/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "fixture", gameUuids: ["queue-one", "queue-two", "queue-two"] }),
    });
    expect(await duplicate.json()).toEqual({ queued: 0 });
    stop();
    await server.exited;
    server = launch();
    const finish = Date.now() + 40000;
    let second: { status?: string; analysis?: { moves: unknown[] } } = {};
    while (Date.now() < finish) {
      try { second = await (await fetch(`http://localhost:${port}/api/analysis/queue-two`)).json(); } catch { /* server is restarting */ }
      if (second.status === "done" || second.status === "error") break;
      await Bun.sleep(50);
    }
    expect(second.status).toBe("done");
    expect(second.analysis?.moves).toHaveLength(4);
    expect((await get())?.status).toBe("done");
  } finally { stop(); await server.exited; }
}, 60000);
