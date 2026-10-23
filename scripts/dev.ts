import path from "node:path";

// Run the API and Vite together and stop both when either exits or on Ctrl+C.
const root = path.resolve(import.meta.dir, "..");
const children = [
  Bun.spawn([process.execPath, "--cwd", "apps/server", "dev"], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn([process.execPath, "--cwd", "apps/web", "dev"], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
];

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
  process.exit(code);
}

for (const child of children) void child.exited.then((code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
