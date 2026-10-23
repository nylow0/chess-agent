// Hash router. The reactive `route` object drives which view renders; in-app
// navigation uses plain `<a href="#/...">` links wherever possible.
export interface Route {
  name: "games" | "game" | "style";
  uuid: string | null;
  ply: number;
  from: "style" | null;
}

const GAMES: Route = { name: "games", uuid: null, ply: 0, from: null };

// Unknown and empty hashes fall back to the games list.
function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);

  if (segments[0] === "style") {
    return { name: "style", uuid: null, ply: 0, from: null };
  }
  if (segments[0] === "game" && segments[1]) {
    const params = new URLSearchParams(query);
    const ply = Number.parseInt(params.get("ply") ?? "", 10);
    return {
      name: "game",
      uuid: segments[1],
      ply: Number.isFinite(ply) && ply > 0 ? ply : 0,
      from: params.get("from") === "style" ? "style" : null,
    };
  }
  return { ...GAMES };
}

export const route = $state<Route>(
  parseHash(typeof location === "undefined" ? "" : location.hash),
);

// Scroll memory, one entry per route (a review is keyed by game id). The router
// records where a screen was left and puts it back once that screen has grown
// back to its old height. Storing it here rather than in each view keeps every
// route behaving the same on in-app links and Back/Forward.
const scrollPositions = new Map<string, number>();

// Set by a click on an in-app link, which records the position before the
// browser jumps to the top of the new fragment.
let clickedLink = false;

function routeKey(value: Route): string {
  return value.name === "game" && value.uuid ? `game/${value.uuid}` : value.name;
}

/** Drop stored scroll positions, e.g. after signing in as another player. */
export function resetScrollPositions(): void {
  scrollPositions.clear();
  clickedLink = false;
}

function restorePosition(key: string): void {
  const y = scrollPositions.get(key) ?? 0;
  if (y <= 0) return;
  const deadline = performance.now() + 3000;
  const step = () => {
    if (routeKey(route) !== key) return;
    const reachable = document.documentElement.scrollHeight - window.innerHeight >= y;
    if (reachable || performance.now() > deadline) {
      window.scrollTo(0, y);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function apply(): void {
  const next = parseHash(location.hash);
  const previousKey = routeKey(route);
  const nextKey = routeKey(next);
  const changed = previousKey !== nextKey;
  if (changed) {
    // Back/Forward arrive with no link click, so record where the page is now.
    if (!clickedLink) scrollPositions.set(previousKey, window.scrollY);
    clickedLink = false;
  }
  Object.assign(route, next);
  if (next.name === "games" && location.hash !== "#/games") {
    history.replaceState(null, "", "#/games");
  }
  if (changed) restorePosition(nextKey);
}

/**
 * Navigate to a hash (with or without the leading `#`). `replace` avoids a new
 * history entry, which is what stepping through moves in a game uses.
 */
export function navigate(hash: string, replace = false): void {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === target) return;
  if (replace) {
    history.replaceState(null, "", target);
    apply();
  } else {
    const next = parseHash(target);
    if (routeKey(next) !== routeKey(route)) {
      scrollPositions.set(routeKey(route), window.scrollY);
      clickedLink = true;
    }
    location.hash = target;
  }
}

if (typeof window !== "undefined") {
  // The router restores scroll itself, so keep the browser out of it.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  // An in-app hash link scrolls the page to the top before `hashchange` fires,
  // so record the outgoing position here, while the old screen is still there.
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname) return;
      if (url.hash === location.hash) return;
      scrollPositions.set(routeKey(route), window.scrollY);
      clickedLink = true;
    },
    true,
  );

  apply();
  window.addEventListener("hashchange", apply);
}
