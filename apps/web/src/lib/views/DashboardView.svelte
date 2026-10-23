<script lang="ts">
  import { onMount } from "svelte";
  import type { GameSummary, ProfileStats } from "@shared";
  import { api, ApiError, type AnalysisStatus } from "../api";
  import { username, clearUsername, readLastSync, markSynced } from "../store";
  import { gamesState, claimUsername, resetFilters, GAMES_PAGE_SIZE } from "../gamesState.svelte";
  import { myResult } from "../chessUtils";
  import { opponentOf } from "../components/games/format";
  import GamesFilters from "../components/games/GamesFilters.svelte";
  import GamesSummary from "../components/games/GamesSummary.svelte";
  import GamesTable from "../components/games/GamesTable.svelte";
  import QueueBanner from "../components/games/QueueBanner.svelte";
  import Button from "../components/ui/Button.svelte";
  import Notice from "../components/ui/Notice.svelte";

  let games = $state<GameSummary[]>([]);
  let stats = $state<ProfileStats | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let syncing = $state(false);
  let importing = $state(false);
  let analyzing = $state(false);
  let stopping = $state(false);
  let stopped = $state(false);
  let syncNotice = $state<{ tone: "success" | "info" | "error"; text: string } | null>(null);
  let optimistic = $state<Record<string, AnalysisStatus>>({});
  let maxQueue = $state(0);
  let loadGeneration = 0;
  let destroyed = false;

  const filtered = $derived.by(() => {
    const name = $username;
    const search = gamesState.search.trim().toLowerCase();
    let list = games;
    if (search) {
      list = list.filter(
        (game) =>
          opponentOf(game, name).username.toLowerCase().includes(search) ||
          (game.opening ?? "").toLowerCase().includes(search),
      );
    }
    if (gamesState.timeClass !== "all") {
      list = list.filter((game) => game.timeClass === gamesState.timeClass);
    }
    if (gamesState.result !== "all") {
      list = list.filter((game) => myResult(game, name) === gamesState.result);
    }
    return sortGames(list, gamesState.sort);
  });

  const visible = $derived(filtered.slice(0, gamesState.shown));
  const hasFilters = $derived(
    gamesState.search.trim() !== "" ||
      gamesState.timeClass !== "all" ||
      gamesState.result !== "all",
  );

  const timeOptions = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const game of games) {
      counts.set(game.timeClass, (counts.get(game.timeClass) ?? 0) + 1);
    }
    const options: { value: string; label: string; count?: number }[] = [
      { value: "all", label: "All", count: games.length },
    ];
    for (const timeClass of [
      { value: "rapid", label: "Rapid" },
      { value: "blitz", label: "Blitz" },
      { value: "bullet", label: "Bullet" },
      { value: "daily", label: "Daily" },
    ]) {
      const count = counts.get(timeClass.value);
      if (count) options.push({ ...timeClass, count });
    }
    return options;
  });

  const newGames = $derived(
    games.filter(
      (game) =>
        !game.analyzed && game.analysisStatus === undefined && optimistic[game.uuid] === undefined,
    ),
  );

  // Optimism contains accepted work only, until a successful read reconciles it.
  const queueLeft = $derived(Math.max(
    stats ? stats.queue.pending + stats.queue.running : 0,
    Object.keys(optimistic).length,
  ));
  const queueActive = $derived(queueLeft > 0);
  const failedCount = $derived(stats?.queue.failed ?? 0);
  const progress = $derived(maxQueue > 0 ? 1 - queueLeft / maxQueue : 0);

  // Sorting keeps games without an accuracy (or move counts) at the bottom.
  function sortGames(list: GameSummary[], sort: typeof gamesState.sort): GameSummary[] {
    const copy = [...list];
    switch (sort) {
      case "oldest":
        return copy.sort((a, b) => a.playedAt - b.playedAt);
      case "accuracy-asc":
        return copy.sort((a, b) => accuracyKey(a, false) - accuracyKey(b, false));
      case "accuracy-desc":
        return copy.sort((a, b) => accuracyKey(b, true) - accuracyKey(a, true));
      case "blunders":
        return copy.sort((a, b) => (b.myCounts?.blunder ?? -1) - (a.myCounts?.blunder ?? -1));
      default:
        return copy.sort((a, b) => b.playedAt - a.playedAt);
    }
  }

  function accuracyKey(game: GameSummary, descending: boolean): number {
    if (game.myAccuracy == null) return descending ? -Infinity : Infinity;
    return game.myAccuracy;
  }

  function statusOf(game: GameSummary): AnalysisStatus | undefined {
    return game.analysisStatus ?? optimistic[game.uuid];
  }

  function updateQueueSeen(left: number): void {
    if (left > 0) {
      if (left > maxQueue) maxQueue = left;
    } else {
      maxQueue = 0;
    }
  }

  function isStale(name: string, generation?: number): boolean {
    return destroyed || name !== $username ||
      (generation !== undefined && generation !== loadGeneration);
  }

  async function loadData(): Promise<boolean> {
    const name = $username;
    if (!name || destroyed) return false;
    const generation = ++loadGeneration;
    try {
      const [list, profile] = await Promise.all([api.games(name), api.profile(name)]);
      if (isStale(name, generation)) return false;
      games = list;
      stats = profile;
      optimistic = {};
      loadError = null;
      updateQueueSeen(profile.queue.pending + profile.queue.running);
      return true;
    } catch (err) {
      if (isStale(name, generation)) return false;
      if (loading && err instanceof ApiError && err.status === 404) {
        clearUsername();
        return false;
      }
      loadError = err instanceof Error ? err.message : "Could not load your games.";
      return false;
    } finally {
      if (!isStale(name, generation)) loading = false;
    }
  }

  // A quiet catch-up sync only when the stored timestamp is stale or missing.
  async function autoSync(name: string): Promise<void> {
    const stored = readLastSync(name);
    if (stored > 0 && Date.now() - stored < 15 * 60_000) return;
    try {
      const result = await api.sync(name);
      if (isStale(name)) return;
      markSynced(name);
      if (result.newGames > 0) await loadData();
    } catch {
      /* An automatic sync failure shows nothing. */
    }
  }

  // The notice shared by "Sync games" and "Import full history".
  function syncResultNotice(newGames: number): { tone: "success" | "info"; text: string } {
    return newGames > 0
      ? { tone: "success", text: `Imported ${newGames} new ${newGames === 1 ? "game" : "games"}.` }
      : { tone: "info", text: "No new games since the last sync." };
  }

  async function syncGames(): Promise<void> {
    const name = $username;
    if (!name || syncing) return;
    syncing = true;
    syncNotice = null;
    stopped = false;
    try {
      const result = await api.sync(name);
      if (isStale(name)) return;
      markSynced(name);
      syncNotice = syncResultNotice(result.newGames);
      await loadData();
    } catch {
      if (isStale(name)) return;
      syncNotice = {
        tone: "error",
        text: "Could not reach Chess.com. Your saved games are shown.",
      };
    } finally {
      if (!isStale(name)) syncing = false;
    }
  }

  async function importHistory(): Promise<void> {
    const name = $username;
    if (!name || importing) return;
    importing = true;
    syncNotice = null;
    stopped = false;
    try {
      const result = await api.sync(name, true);
      if (isStale(name)) return;
      markSynced(name);
      syncNotice = syncResultNotice(result.newGames);
      await loadData();
    } catch {
      if (isStale(name)) return;
      syncNotice = {
        tone: "error",
        text: "Could not reach Chess.com. Your saved games are shown.",
      };
    } finally {
      if (!isStale(name)) importing = false;
    }
  }

  async function analyze(uuids: string[]): Promise<void> {
    const name = $username;
    if (!name || uuids.length === 0) return;
    analyzing = true;
    stopped = false;
    try {
      await api.analyze(name, uuids);
      if (isStale(name)) return;
      for (const uuid of uuids) optimistic[uuid] = "pending";
      await loadData();
    } catch {
      if (isStale(name)) return;
      syncNotice = { tone: "error", text: "Could not start the analysis. Try again." };
    } finally {
      if (!isStale(name)) analyzing = false;
    }
  }

  async function stopAnalysis(): Promise<void> {
    const name = $username;
    if (!name || stopping) return;
    stopping = true;
    try {
      await api.cancelAnalysis(name);
      if (isStale(name)) return;
      stopped = true;
      syncNotice = null;
      await loadData();
    } catch {
      if (isStale(name)) return;
      syncNotice = { tone: "error", text: "Could not stop the queue. Try again." };
    } finally {
      if (!isStale(name)) stopping = false;
    }
  }

  function retryFailed(): void {
    const uuids = games.filter((game) => game.analysisStatus === "error").map((game) => game.uuid);
    void analyze(uuids);
  }

  function showMore(): void {
    gamesState.shown += GAMES_PAGE_SIZE;
  }

  onMount(() => {
    const name = $username;
    if (name) {
      claimUsername(name);
      void loadData();
      void autoSync(name);
    }
    return () => { destroyed = true; };
  });

  // Poll only while something is queued; otherwise the list stays still.
  $effect(() => {
    if (!queueActive) return;
    const timer = setInterval(() => void loadData(), 3000);
    return () => clearInterval(timer);
  });

  // The "Stopped" notice is only meaningful while something is still finishing.
  $effect(() => {
    if (stopped && !queueActive) stopped = false;
  });
</script>

<div class="px-4 py-8 sm:px-6 lg:px-10">
  <header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
    <div>
      <h1 class="text-[28px] font-extrabold leading-[34px] tracking-tight text-text">Games</h1>
      <p class="mt-1 text-[13px] text-muted">
        {$username} on Chess.com, {games.length}
        {games.length === 1 ? "game" : "games"}
      </p>
    </div>
    <!-- On desktop the action row is exactly the heading's line box, so the
         buttons centre on the "Games" line and the subtitle below never
         pushes them down. On phones the row wraps under the subtitle. -->
    <div class="flex flex-wrap items-center gap-2 lg:h-[34px]">
      <Button variant="secondary" loading={syncing} disabled={importing} onclick={syncGames}>
        <svg viewBox="0 0 16 16" class="size-4" fill="none" aria-hidden="true">
          <path
            d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97M13.5 1.75v2.5H11"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Sync games
      </Button>
      <Button variant="ghost" loading={importing} disabled={syncing} onclick={importHistory}>
        Import full history
      </Button>
      {#if newGames.length > 0 && !queueActive}
        <Button
          variant="primary"
          loading={analyzing}
          onclick={() => analyze(newGames.map((game) => game.uuid))}
        >
          Analyze {newGames.length} new {newGames.length === 1 ? "game" : "games"}
        </Button>
      {/if}
    </div>
  </header>

  <div class="mt-5 space-y-3">
    {#if loadError}
      <Notice tone="error" onRetry={() => void loadData()}>{loadError}</Notice>
    {/if}
    {#if importing}
      <Notice tone="info">
        Importing your full history from Chess.com. This can take a minute.
      </Notice>
    {:else if syncNotice}
      <Notice
        tone={syncNotice.tone}
        onRetry={syncNotice.tone === "error" ? syncGames : undefined}
      >
        {syncNotice.text}
      </Notice>
    {/if}
    {#if stopped}
      <Notice tone="info">Stopped. The game being analyzed right now will still finish.</Notice>
    {/if}
  </div>

  {#if loading}
    <div class="mt-8 space-y-2" role="status" aria-label="Loading games">
      {#each Array.from({ length: 6 }) as _, i (i)}
        <div class="h-12 animate-pulse rounded-control bg-surface"></div>
      {/each}
    </div>
  {:else if !loadError && games.length === 0}
    <div class="mx-auto mt-20 max-w-sm text-center">
      <p class="text-base text-text">No games yet.</p>
      <p class="mt-2 text-sm text-muted">
        Sync to import your last six months from Chess.com.
      </p>
      <Button variant="primary" class="mt-6" loading={syncing} onclick={syncGames}>
        Sync games
      </Button>
    </div>
  {:else if games.length > 0}
    {#if queueActive}
      <div class="mt-6">
        <QueueBanner left={queueLeft} {progress} stopping={stopping} onStop={stopAnalysis} />
      </div>
    {/if}

    {#if failedCount > 0}
      <div
        class="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-panel border-l-[3px] border-l-loss bg-surface px-5 py-3"
        role="alert"
      >
        <p class="text-sm text-text">
          {failedCount} {failedCount === 1 ? "game" : "games"} could not be analyzed.
        </p>
        <Button variant="secondary" size="sm" class="shrink-0" onclick={retryFailed}>
          Try again
        </Button>
      </div>
    {/if}

    <div class="mt-6">
      <GamesFilters {timeOptions} {hasFilters} />
    </div>

    <div class="mt-6">
      <GamesSummary games={filtered} username={$username} />
    </div>

    <div class="mt-8">
      <p class="text-[13px] text-muted">Showing {visible.length} of {filtered.length} games</p>

      {#if visible.length === 0}
        <div class="mt-12 text-center">
          <p class="text-base text-text">No games match these filters.</p>
          <Button variant="secondary" class="mt-4" onclick={resetFilters}>Clear filters</Button>
        </div>
      {:else}
        <div class="mt-3">
          <GamesTable
            games={visible}
            username={$username}
            {statusOf}
            onAnalyze={(uuid) => analyze([uuid])}
            onRetry={(uuid) => analyze([uuid])}
          />
        </div>
        {#if visible.length < filtered.length}
          <div class="mt-4">
            <Button variant="secondary" class="w-full" onclick={showMore}>
              Show {GAMES_PAGE_SIZE} more
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
