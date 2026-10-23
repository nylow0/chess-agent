import type { GameSummary, PlayerSummary } from "@shared";

/** The player on the other side of the board from `username`. */
export function opponentOf(game: GameSummary, username: string | null): PlayerSummary {
  if (username && game.white.username.toLowerCase() === username.toLowerCase()) {
    return game.black;
  }
  return game.white;
}

/** Short list label: Today, Yesterday, "N days ago", else "Sep 13" (with year when needed). */
export function playedLabel(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 6) return `${days} days ago`;
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
}

/** Full local date and time for a cell's `title`. */
export function playedTitle(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
