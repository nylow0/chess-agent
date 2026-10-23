// Filter and paging state for the Games list. It lives at module level so
// opening a game and coming back (Back or the "Games" link) restores the view.
// Scroll position is handled by the router.

export type GameSort = "newest" | "oldest" | "accuracy-asc" | "accuracy-desc" | "blunders";

export interface GamesListState {
  search: string;
  /** "all" or a time class ("bullet" | "blitz" | "rapid" | "daily"). */
  timeClass: string;
  /** "all", "win", "loss" or "draw". */
  result: string;
  sort: GameSort;
  shown: number;
  /** Which player the stored filters belong to; switching players clears them. */
  owner: string | null;
}

export const GAMES_PAGE_SIZE = 50;

export const gamesState = $state<GamesListState>({
  search: "",
  timeClass: "all",
  result: "all",
  sort: "newest",
  shown: GAMES_PAGE_SIZE,
  owner: null,
});

export function resetFilters(): void {
  gamesState.search = "";
  gamesState.timeClass = "all";
  gamesState.result = "all";
  gamesState.sort = "newest";
  gamesState.shown = GAMES_PAGE_SIZE;
}

/** Clear stored filters the first time a different player is shown. */
export function claimUsername(name: string): void {
  if (gamesState.owner === name) return;
  gamesState.owner = name;
  resetFilters();
}
