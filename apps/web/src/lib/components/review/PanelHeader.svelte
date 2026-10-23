<!--
  Fixed top zone of the review panel: the back link, the Chess.com link and
  the facts line (result, termination, date, time class, opening). The player
  bars carry the names; the sr-only h1 keeps the page's level-1 heading.
-->
<script lang="ts">
  import type { GameDetail } from "@shared";
  import { route } from "../../router.svelte";
  import ResultChip from "../ResultChip.svelte";
  import TimeClassBadge from "../TimeClassBadge.svelte";

  let {
    game,
    result,
    termination,
  }: {
    game: GameDetail;
    result: "win" | "loss" | "draw" | null;
    termination: string | null;
  } = $props();
</script>

<header class="panel-header shrink-0 px-4 pb-2 pt-3">
  <div class="flex items-center justify-between gap-3">
    <a
      href={route.from === "style" ? "#/style" : "#/games"}
      class="inline-flex min-h-8 items-center gap-1 rounded-control text-[13px] font-semibold text-muted transition-colors hover:text-text lg:min-h-0"
    >
      <svg viewBox="0 0 16 16" class="size-3.5" fill="none" aria-hidden="true">
        <path
          d="M10 3L5 8l5 5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {route.from === "style" ? "Your style" : "All games"}
    </a>
    {#if game.url}
      <a
        href={game.url}
        target="_blank"
        rel="noreferrer"
        class="text-[13px] font-semibold text-muted transition-colors hover:text-text"
      >
        Open on Chess.com
      </a>
    {/if}
  </div>
  <h1 class="sr-only">{game.white.username} vs {game.black.username}</h1>
  <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
    {#if result}<ResultChip {result} />{/if}
    {#if termination}<span class="min-w-0">{termination}</span>{/if}
    <span class="tabular-nums">
      {new Date(game.playedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}
    </span>
    <TimeClassBadge timeClass={game.timeClass} />
    {#if game.opening}
      <span class="min-w-0 flex-1 basis-32 truncate" title={game.opening}>
        {game.opening}
      </span>
    {/if}
  </div>
</header>
