<!--
  The games list. Below 1024px each game is a 64px row link; from 1024px an
  archive-style grid: 56px rows on a shared column template (the header shares
  the template so columns align), no rules between rows, hover raises the row.
  A row's grid also holds the analysis-status cell; its action buttons sit
  above the covering link so clicking Analyze/Retry never opens the game.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { GameSummary } from "@shared";
  import type { AnalysisStatus } from "../../api";
  import { moverIsWhite, myResult } from "../../chessUtils";
  import { opponentOf, playedLabel, playedTitle } from "./format";
  import ColorChip from "../ColorChip.svelte";
  import ResultChip from "../ResultChip.svelte";
  import TimeClassBadge from "../TimeClassBadge.svelte";
  import MoveBadge from "../MoveBadge.svelte";
  import Button from "../ui/Button.svelte";
  import Spinner from "../ui/Spinner.svelte";

  let {
    games,
    username,
    statusOf,
    onAnalyze,
    onRetry,
  }: {
    games: GameSummary[];
    username: string | null;
    statusOf: (game: GameSummary) => AnalysisStatus | undefined;
    onAnalyze: (uuid: string) => void;
    onRetry: (uuid: string) => void;
  } = $props();

  // Only one of the two layouts is in the DOM, so `data-testid` stays unique.
  // The grid needs the full width for its columns, so narrower screens use
  // the phone list instead.
  let desktop = $state(
    typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches,
  );

  onMount(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => (desktop = query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  // Shared column template for the header row and every game row, so the
  // columns align. The status column is last-but-one and auto-sized: when no
  // visible row needs it, the template drops it entirely so it takes no
  // width, and Date stays the final, right-aligned column.
  const needsStatus = $derived(games.some((game) => !game.analyzed));
  const columns = $derived(
    needsStatus
      ? "grid grid-cols-[88px_minmax(140px,1.1fr)_minmax(0,1.6fr)_92px_84px_96px_auto_124px] items-center gap-x-3"
      : "grid grid-cols-[88px_minmax(140px,1.1fr)_minmax(0,1.6fr)_92px_84px_96px_124px] items-center gap-x-3",
  );
</script>

{#if desktop}
  <!-- The divider and the content share the panel's edges exactly; rows may
       bleed their hover background 8px past them via negative margin. -->
  <div
    class="{columns} border-b border-line pb-2.5 text-xs font-semibold text-muted"
    data-testid="games-table-header"
  >
    <span>Result</span>
    <span>Opponent</span>
    <span>Opening</span>
    <span>Time</span>
    <span>Accuracy</span>
    <span>Mistakes</span>
    {#if needsStatus}<span class="sr-only">Analysis</span>{/if}
    <span class="text-right">Date</span>
  </div>

  <div class="space-y-0.5">
    {#each games as game (game.uuid)}
      {@const result = myResult(game, username)}
      {@const opponent = opponentOf(game, username)}
      {@const status = statusOf(game)}
      {@const blunders = game.analyzed ? game.myCounts?.blunder : undefined}
      {@const mistakes = game.analyzed ? game.myCounts?.mistake : undefined}
      {@const mine = moverIsWhite(game, username)}
      <div
        class="{columns} -mx-2 relative h-14 cursor-pointer rounded-control px-2 transition-colors hover:bg-raised"
      >
        <a
          data-testid={`game-${game.uuid}`}
          href={`#/game/${game.uuid}`}
          class="absolute inset-0 z-0 rounded-control"
          aria-label={`Game versus ${opponent.username}, ${playedLabel(game.playedAt)}`}
        ></a>

        <span class="relative">
          {#if result}
            <ResultChip {result} />
          {:else}
            <span class="text-muted">–</span>
          {/if}
        </span>

        <span class="min-w-0">
          <span class="flex items-center gap-2">
            <span class="truncate text-[14px] font-semibold text-text">{opponent.username}</span>
            <span class="shrink-0 text-[13px] text-muted tabular-nums">{opponent.rating}</span>
          </span>
          <span class="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <ColorChip white={mine} label={mine ? "You played white" : "You played black"} />
            <span>{mine ? "white" : "black"}</span>
          </span>
        </span>

        <span
          class="block min-w-0 truncate text-[13px] text-muted"
          title={game.opening ?? undefined}
        >
          {game.opening ?? "–"}
        </span>

        <span><TimeClassBadge timeClass={game.timeClass} /></span>

        <!-- The chip hugs its content; unanalysed games show a muted dash
             without a chip. -->
        <span>
          {#if game.analyzed && game.myAccuracy != null}
            <span
              class="inline-flex h-7 min-w-14 items-center justify-center rounded-control bg-[#333333] px-2 text-[13px] font-semibold tabular-nums text-text"
            >
              {game.myAccuracy.toFixed(1)}%
            </span>
          {:else}
            <span class="text-muted">–</span>
          {/if}
        </span>

        <span class="flex items-center gap-2.5">
          {#if game.analyzed && blunders}
            <span class="inline-flex items-center gap-1">
              <MoveBadge classification="blunder" size={14} />
              <span class="text-[13px] font-semibold text-cls-blunder tabular-nums">{blunders}</span>
            </span>
          {/if}
          {#if game.analyzed && mistakes}
            <span class="inline-flex items-center gap-1">
              <MoveBadge classification="mistake" size={14} />
              <span class="text-[13px] font-semibold text-cls-mistake tabular-nums">{mistakes}</span>
            </span>
          {/if}
        </span>

        {#if needsStatus}
          <span class="relative z-10 flex justify-end">
            {#if !game.analyzed}
              {#if status === "pending"}
                <span class="text-[13px] text-muted">Queued</span>
              {:else if status === "running"}
                <span class="inline-flex items-center gap-1.5 text-[13px] text-text">
                  <Spinner class="size-3.5" />
                  Analyzing
                </span>
              {:else if status === "error"}
                <span class="inline-flex items-center gap-2">
                  <span class="text-[13px] font-semibold text-loss">Failed</span>
                  <Button size="sm" onclick={() => onRetry(game.uuid)}>Retry</Button>
                </span>
              {:else}
                <Button size="sm" onclick={() => onAnalyze(game.uuid)}>Analyze</Button>
              {/if}
            {/if}
          </span>
        {/if}

        <span class="text-right text-[13px] text-muted" title={playedTitle(game.playedAt)}>
          {playedLabel(game.playedAt)}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="space-y-1">
    {#each games as game (game.uuid)}
      {@const result = myResult(game, username)}
      {@const opponent = opponentOf(game, username)}
      {@const mine = moverIsWhite(game, username)}
      <a
        data-testid={`game-${game.uuid}`}
        href={`#/game/${game.uuid}`}
        class="flex h-16 items-center gap-3 rounded-control px-2 transition-colors hover:bg-raised"
      >
        <span class="shrink-0">
          {#if result}
            <ResultChip {result} />
          {:else}
            <span class="text-muted">–</span>
          {/if}
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <ColorChip white={mine} label={mine ? "You played white" : "You played black"} />
            <span class="truncate text-[14px] font-semibold text-text">{opponent.username}</span>
            <span class="shrink-0 text-[13px] text-muted tabular-nums">{opponent.rating}</span>
          </span>
          <span class="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
            <span class="min-w-0 flex-1 truncate">{game.opening ?? "–"}</span>
            <TimeClassBadge timeClass={game.timeClass} />
            <span class="shrink-0 whitespace-nowrap tabular-nums">{playedLabel(game.playedAt)}</span>
          </span>
        </span>
        <span class="shrink-0">
          {#if game.analyzed && game.myAccuracy != null}
            <span
              class="inline-flex h-7 min-w-14 items-center justify-center rounded-control bg-[#333333] px-2 text-[13px] font-semibold tabular-nums text-text"
            >
              {game.myAccuracy.toFixed(1)}%
            </span>
          {:else}
            <span class="text-muted">–</span>
          {/if}
        </span>
      </a>
    {/each}
  </div>
{/if}
