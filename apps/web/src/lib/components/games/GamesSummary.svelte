<!--
  Overview strip: one surface panel with four figures in a row, separated by
  spacing only. Every figure reads from the filtered games passed in.
-->
<script lang="ts">
  import type { GameSummary } from "@shared";
  import { myResult } from "../../chessUtils";

  let { games, username }: { games: GameSummary[]; username: string | null } = $props();

  const wins = $derived(games.filter((game) => myResult(game, username) === "win").length);
  const draws = $derived(games.filter((game) => myResult(game, username) === "draw").length);
  const losses = $derived(games.filter((game) => myResult(game, username) === "loss").length);
  const played = $derived(wins + draws + losses);
  const analyzed = $derived(games.filter((game) => game.analyzed && game.myAccuracy != null));
  const avgAccuracy = $derived(
    analyzed.length > 0
      ? analyzed.reduce((sum, game) => sum + (game.myAccuracy ?? 0), 0) / analyzed.length
      : null,
  );
  const winRate = $derived(played > 0 ? Math.round((wins / played) * 100) : null);

  function share(count: number): string {
    return played > 0 ? `${(count / played) * 100}%` : "0%";
  }

  const figure = "text-[28px] font-extrabold tracking-tight text-text tabular-nums";
  const label = "mt-1 text-[13px] text-muted";
</script>

<div
  class="grid grid-cols-2 gap-x-8 gap-y-6 rounded-panel bg-surface px-6 py-5 lg:grid-cols-[0.9fr_1.7fr_0.9fr_1.2fr] lg:gap-x-10"
  data-testid="games-summary"
>
  <div>
    <div class={figure} data-testid="summary-games">{games.length}</div>
    <div class={label}>Games</div>
  </div>

  <div>
    {#if games.length === 0}
      <div class={figure} data-testid="record-empty">–</div>
    {:else}
      <div
        class="flex flex-wrap items-baseline gap-x-3 text-[28px] font-extrabold tracking-tight text-text tabular-nums lg:flex-nowrap"
        data-testid="record"
      >
        <span class="flex items-baseline gap-1 whitespace-nowrap"
          ><span data-testid="record-won">{wins}</span>
          <span class="text-[13px] font-semibold text-muted">won</span></span
        >
        <span class="flex items-baseline gap-1 whitespace-nowrap"
          ><span data-testid="record-drawn">{draws}</span>
          <span class="text-[13px] font-semibold text-muted">drawn</span></span
        >
        <span class="flex items-baseline gap-1 whitespace-nowrap"
          ><span data-testid="record-lost">{losses}</span>
          <span class="text-[13px] font-semibold text-muted">lost</span></span
        >
      </div>
      <div class="mt-2 flex h-[6px] max-w-[240px] overflow-hidden rounded-[3px] bg-raised">
        <div class="bg-win" style={`width: ${share(wins)}`}></div>
        <div class="bg-draw" style={`width: ${share(draws)}`}></div>
        <div class="bg-loss" style={`width: ${share(losses)}`}></div>
      </div>
    {/if}
  </div>

  <div>
    <div class={figure} data-testid="summary-win-rate">
      {winRate === null ? "–" : `${winRate}%`}
    </div>
    <div class={label}>Win rate</div>
  </div>

  <div>
    <div class={figure} data-testid="summary-accuracy">
      {avgAccuracy === null ? "–" : `${avgAccuracy.toFixed(1)}%`}
    </div>
    <div class={label}>Average accuracy</div>
    {#if games.length > 0}
      <div class="text-xs text-muted">from {analyzed.length} analyzed games</div>
    {/if}
  </div>
</div>
