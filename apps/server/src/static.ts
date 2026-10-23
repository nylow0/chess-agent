import path from "node:path";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serve a file from the built web app with explicit headers.
 * Bun infers Content-Type from the file, but the cors middleware re-wraps the
 * response and drops it, so every branch sets the header itself.
 */
export async function serveWebApp(distDir: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // A NUL byte makes Bun.file throw; treat it as a bad path, not a server error.
  if (decoded.includes("\0")) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const indexPath = path.join(distDir, "index.html");
  if (!(await Bun.file(indexPath).exists())) {
    return new Response("Run `bun run build` to build the web app.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(distDir, relative);
  if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const wantsIndex = pathname === "/" || pathname.endsWith("/");
  const file = Bun.file(wantsIndex ? indexPath : resolved);
  if (!wantsIndex && (await file.exists())) {
    // Hashed asset names never change, so they can be cached hard for a year.
    const cacheControl = pathname.startsWith("/assets/") ? IMMUTABLE : "no-cache";
    return new Response(file, {
      headers: { "Content-Type": file.type, "Cache-Control": cacheControl },
    });
  }
  return new Response(Bun.file(indexPath), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
