import type { EngineLine } from "@chess/shared";
import path from "node:path";
import { Chess } from "chess.js";

const ENGINE_PATH = path.resolve(import.meta.dir, "../../../engine/reckless-windows-avx2.exe");
const ENGINE_NAME = "Reckless";
const ENGINE_VERSION = "0.9.0";

export class EngineStartError extends Error {}

// UCI scores are side-to-move POV: higher = better for the side to move.
interface RawInfo {
  multipv: number;
  depth: number;
  bound: boolean;
  line: EngineLine;
}

function parseInfoLine(line: string): RawInfo | null {
  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const pvMatch = line.match(/\bpv\s+(.+)$/);
  if (!depthMatch || !pvMatch) return null;

  let cp: number | null = null;
  let mate: number | null = null;
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
  if (cpMatch) cp = Number.parseInt(cpMatch[1], 10);
  else if (mateMatch) mate = Number.parseInt(mateMatch[1], 10);
  else return null;

  const pv = pvMatch[1].trim().split(/\s+/).filter(Boolean);
  if (pv.length === 0) return null;

  const multipvMatch = line.match(/\bmultipv\s+(\d+)/);
  return {
    multipv: multipvMatch ? Number.parseInt(multipvMatch[1], 10) : 1,
    depth: Number.parseInt(depthMatch[1], 10),
    bound: /\b(lowerbound|upperbound)\b/.test(line),
    line: { uci: pv[0], san: "", cp, mate, pv },
  };
}

// One entry per MultiPV rank: deepest search wins; exact scores beat bound
// scores at equal depth. Result ordered best-first by the engine's own rank.
function selectBestLines(infos: RawInfo[]): EngineLine[] {
  const byRank = new Map<number, RawInfo>();
  for (const info of infos) {
    const cur = byRank.get(info.multipv);
    if (
      !cur ||
      info.depth > cur.depth ||
      (info.depth === cur.depth && (!info.bound || cur.bound))
    ) {
      byRank.set(info.multipv, info);
    }
  }
  return [...byRank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, info]) => info.line);
}

interface PendingWaiter {
  resolve: () => void;
}

type EngineProc = Bun.Subprocess<"pipe", "pipe", "ignore">;

export class Engine {
  private proc: EngineProc | null = null;
  private lineBuffer = "";
  private waiters: PendingWaiter[] = [];
  private lines: string[] = [];
  private reader: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private analysisTail: Promise<unknown> = Promise.resolve();
  private started = false;

  get isReady(): boolean {
    return this.started && this.proc !== null && this.proc.exitCode === null;
  }

  async ensureStarted(): Promise<void> {
    if (this.isReady) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    let proc: EngineProc;
    try {
      proc = Bun.spawn({
        cmd: [ENGINE_PATH],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch (err) {
      throw new EngineStartError(
        `failed to start engine at ${ENGINE_PATH}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.proc = proc;
    this.lineBuffer = "";
    this.lines = [];

    this.reader = this.readLoop(proc).catch((err) => {
      console.error("engine stdout reader crashed:", err);
    });

    try {
      await this.sendAndAwait("uci", "uciok", 10_000);
      await this.send("setoption name MultiPV value 6");
      await this.send("setoption name Threads value 2");
      await this.send("setoption name Hash value 64");
      await this.sendAndAwait("isready", "readyok", 10_000);
      this.started = true;
    } catch (err) {
      this.kill();
      this.started = false;
      throw new EngineStartError(
        `engine handshake failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async readLoop(proc: EngineProc): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      if (this.proc !== proc) return;
      this.lineBuffer += decoder.decode(chunk, { stream: true });
      let idx = this.lineBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.lineBuffer.slice(0, idx).replace(/\r$/, "");
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        this.onLine(line);
        idx = this.lineBuffer.indexOf("\n");
      }
    }
  }

  private onLine(line: string): void {
    if (line === "uciok" || line === "readyok") {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve();
      return;
    }
    this.lines.push(line);
  }

  private async send(cmd: string): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new EngineStartError("engine is not running");
    }
    const stdin = this.proc.stdin;
    if (!stdin) throw new EngineStartError("engine stdin unavailable");
    await stdin.write(cmd + "\n");
    await stdin.flush();
  }

  private async sendAndAwait(cmd: string, token: string, timeoutMs: number): Promise<void> {
    this.lines = [];
    const waiter: PendingWaiter = { resolve: () => {} };
    const done = new Promise<void>((resolve) => {
      waiter.resolve = resolve;
    });
    this.waiters.push(waiter);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const i = this.waiters.indexOf(waiter);
      if (i !== -1) this.waiters.splice(i, 1);
      waiter.resolve();
    }, timeoutMs);
    try {
      await this.send(cmd);
      await done;
      if (timedOut) throw new Error(`timeout waiting for "${token}" from engine`);
      if (!this.proc || this.proc.exitCode !== null) {
        throw new Error("engine process exited unexpectedly");
      }
    } finally {
      clearTimeout(timer);
      const i = this.waiters.indexOf(waiter);
      if (i !== -1) this.waiters.splice(i, 1);
    }
  }

  analyze(fen: string, depth = 14, searchMove?: string): Promise<EngineLine[]> {
    // One command stream per process, including callers arriving during startup.
    const result = this.analysisTail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.search(fen, depth, searchMove);
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
    });
    this.analysisTail = result.catch(() => {});
    return result;
  }

  private async search(fen: string, depth: number, searchMove?: string, multiPv = 6): Promise<EngineLine[]> {
    if (searchMove) {
      // Reckless 0.9 ignores UCI searchmoves. Fix the root move on the board,
      // search its reply at depth - 1, then restore root-side score and PV.
      const child = new Chess(fen);
      const move = child.move({ from: searchMove.slice(0, 2), to: searchMove.slice(2, 4), promotion: searchMove[4] });
      if (child.isGameOver()) return [{ uci: searchMove, san: move.san, cp: child.isCheckmate() ? null : 0, mate: child.isCheckmate() ? 1 : null, pv: [searchMove] }];
      const reply = (await this.search(child.fen(), Math.max(1, depth - 1), undefined, 1))[0];
      return [{ ...reply, uci: searchMove, san: move.san,
        cp: reply.cp === null ? null : -reply.cp,
        mate: reply.mate === null ? null : reply.mate > 0 ? -reply.mate : -reply.mate + 1,
        pv: [searchMove, ...reply.pv] }];
    }
    await this.ensureStarted();
    const proc = this.proc;
    try {
      // ucinewgame clears the transposition table and search state. Without it a
      // long-lived engine drifts: the score of a position depends on what was
      // searched before it, so every search must start from a clean state.
      await this.send("ucinewgame");
      await this.sendAndAwait("isready", "readyok", 10_000);
      this.lines = [];
      await this.send(`setoption name MultiPV value ${multiPv}`);
      await this.send(`position fen ${fen}`);
      await this.send(`go depth ${depth}`);

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (!proc || this.proc !== proc || proc.exitCode !== null) {
          throw new EngineStartError("engine process exited or was replaced during analysis");
        }
        const best = this.lines.find((l) => l.startsWith("bestmove"));
        if (best) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const best = this.lines.find((l) => l.startsWith("bestmove"));
      if (!best) throw new Error("engine did not return bestmove in time");

      const infos: RawInfo[] = [];
      for (const line of this.lines) {
        const info = parseInfoLine(line);
        if (info) infos.push(info);
      }
      const result = selectBestLines(infos);
      if (result.length === 0) throw new Error("engine returned no scored moves");
      return result.filter((line, i) => result.findIndex((other) => other.uci === line.uci) === i);
    } catch (error) {
      // A status request may already be handshaking a replacement. Let that
      // process finish startup so the retry can use it instead of killing it.
      if (this.proc === proc) this.kill();
      throw error;
    }
  }

  kill(): void {
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      // index.ts exits right after shutdownEngine(), so a delayed kill timer
      // never runs. Kill now to guarantee the engine is not orphaned.
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.started = false;
    this.proc = null;
  }
}

export function cpFromWhitePov(line: EngineLine, sideToMoveIsWhite: boolean): number | null {
  if (line.cp !== null) return sideToMoveIsWhite ? line.cp : -line.cp;
  return null;
}

export function mateFromWhitePov(line: EngineLine, sideToMoveIsWhite: boolean): number | null {
  if (line.mate !== null) return sideToMoveIsWhite ? line.mate : -line.mate;
  return null;
}

export const engine = new Engine();
export const engineMeta = { name: ENGINE_NAME, version: ENGINE_VERSION };
