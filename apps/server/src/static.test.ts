import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { serveWebApp } from "./static";

// Temp trees under .artifacts so nothing outside the repo is touched.
const root = path.resolve(import.meta.dir, "../../../.artifacts/static-test");
const dist = path.join(root, crypto.randomUUID());
const empty = path.join(root, crypto.randomUUID());
const INDEX_HTML = "<!doctype html><html><body>index body</body></html>";
const JS = "export const app = 1;\n";
const CSS = ".app { color: red; }\n";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

await mkdir(path.join(dist, "assets"), { recursive: true });
await mkdir(empty, { recursive: true });
await Bun.write(path.join(dist, "index.html"), INDEX_HTML);
await Bun.write(path.join(dist, "assets/app-abc123.js"), JS);
await Bun.write(path.join(dist, "assets/app-abc123.css"), CSS);
await Bun.write(path.join(dist, "favicon.svg"), SVG);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("root serves index.html as no-cache html", async () => {
  const response = await serveWebApp(dist, "/");
  expect(response.status).toBe(200);
  expect((response.headers.get("Content-Type") ?? "")).toStartWith("text/html");
  expect(response.headers.get("Cache-Control")).toBe("no-cache");
  expect(await response.text()).toBe(INDEX_HTML);
});

test("hashed javascript asset gets its type and a long cache", async () => {
  const response = await serveWebApp(dist, "/assets/app-abc123.js");
  expect(response.status).toBe(200);
  expect((response.headers.get("Content-Type") ?? "")).toContain("javascript");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(await response.text()).toBe(JS);
});

test("hashed css asset gets a css type", async () => {
  const response = await serveWebApp(dist, "/assets/app-abc123.css");
  expect((response.headers.get("Content-Type") ?? "")).toStartWith("text/css");
});

test("favicon gets an svg type", async () => {
  const response = await serveWebApp(dist, "/favicon.svg");
  expect((response.headers.get("Content-Type") ?? "")).toStartWith("image/svg+xml");
});

test("unknown paths fall back to index.html", async () => {
  const response = await serveWebApp(dist, "/some/unknown/path");
  expect(response.status).toBe(200);
  expect((response.headers.get("Content-Type") ?? "")).toStartWith("text/html");
  expect(await response.text()).toBe(INDEX_HTML);
});

test("traversal and malformed escapes are not found", async () => {
  for (const pathname of ["/..%2f..%2fpackage.json", "/%E0%A4%A"]) {
    const response = await serveWebApp(dist, pathname);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
});

test("a NUL byte in the path is not found instead of a server error", async () => {
  for (const pathname of ["/%00", "/index.html%00", "/assets/app-abc123.js%00"]) {
    const response = await serveWebApp(dist, pathname);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
});

test("a missing build prints the build hint as plain text", async () => {
  const response = await serveWebApp(empty, "/");
  expect((response.headers.get("Content-Type") ?? "")).toStartWith("text/plain");
  expect(await response.text()).toContain("bun run build");
});

test("explicit Content-Type survives the cors middleware over real HTTP", async () => {
  const app = new Hono();
  app.use("*", cors({ origin: "*" }));
  app.get("*", (c) => serveWebApp(dist, new URL(c.req.url).pathname));
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const response = await fetch(`http://localhost:${server.port}/assets/app-abc123.js`);
    expect((response.headers.get("Content-Type") ?? "")).toContain("javascript");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.text()).toBe(JS);
  } finally {
    server.stop(true);
  }
});
