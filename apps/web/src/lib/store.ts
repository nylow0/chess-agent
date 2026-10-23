import { writable } from "svelte/store";
import { resetScrollPositions } from "./router.svelte";

const KEY = "chess-username";

// Some browser profiles block storage access entirely, so reads and writes then
// throw. Treat a blocked store as empty; the app still works for the session.
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is blocked; the value only matters across reloads. */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage is blocked. */
  }
}

/** localStorage key holding the last time `name` was synced from Chess.com. */
function lastSyncKey(name: string): string {
  return `chess-last-sync:${name}`;
}

/** When `name` was last synced, or 0 when it is unknown or storage is blocked. */
export function readLastSync(name: string): number {
  const raw = safeGet(lastSyncKey(name));
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Record a successful sync so the Games screen skips its catch-up sync. */
export function markSynced(name: string): void {
  safeSet(lastSyncKey(name), String(Date.now()));
}

export const username = writable<string | null>(safeGet(KEY));

export function setUsername(name: string): void {
  safeSet(KEY, name);
  resetScrollPositions();
  username.set(name);
}

export function clearUsername(): void {
  safeRemove(KEY);
  username.set(null);
}
