<script lang="ts">
  import { onMount } from "svelte";
  import type { EngineLine, MoveAnalysis } from "@shared";
  import { pvToSan, evalLabel } from "../chessUtils";
  import Button from "./ui/Button.svelte";

  let {
    move,
    onHover,
  }: {
    move: MoveAnalysis | null;
    onHover: (uci: string | null) => void;
  } = $props();

  let open = $state(false);
  let showAll = $state(false);

  // Closed by default at every width; remember the player's choice.
  onMount(() => {
    try {
      open = localStorage.getItem("chess-engine-lines-open") === "true";
    } catch {
      open = false;
    }
  });

  // Persist synchronously on the summary click. The details "toggle" event is
  // queued as a task, so a reload in the same turn would otherwise lose it.
  function rememberClick(event: MouseEvent) {
    const details = (event.currentTarget as HTMLElement).closest("details");
    if (!(details instanceof HTMLDetailsElement)) return;
    try {
      localStorage.setItem("chess-engine-lines-open", String(!details.open));
    } catch {
      // Storage can be blocked; the choice just does not persist.
    }
  }

  function lineSans(line: EngineLine): { first: string; rest: string[] } {
    const sans = move ? pvToSan(move.fenBefore, line.pv, 8) : [];
    const first = line.san || sans[0] || line.uci.slice(0, 4);
    return { first, rest: sans.slice(1) };
  }

  // White-perspective score: White better gets the light pill, Black better
  // the dark one, like Chess.com's engine lines.
  function pillClass(line: EngineLine): string {
    const whiteBetter = line.mate !== null ? line.mate > 0 : (line.cp ?? 0) > 0;
    return whiteBetter ? "bg-text text-bg" : "bg-[#333333] text-text";
  }

  const lines = $derived(move?.lines ?? []);
  const shown = $derived(showAll ? lines : lines.slice(0, 3));
</script>

<details bind:open>
  <summary
    onclick={rememberClick}
    class="flex min-h-9 w-full shrink-0 cursor-pointer select-none items-center gap-1.5 text-[13px] font-semibold text-muted transition-colors hover:text-text"
  >
    <svg
      viewBox="0 0 16 16"
      class="size-3 transition-transform {open ? 'rotate-90' : ''}"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    Engine lines
  </summary>
  <div class="mt-1">
    {#if move && lines.length > 0}
      <div class="space-y-0.5">
        {#each shown as line, i (line.uci)}
          {@const sans = lineSans(line)}
          <button
            class="flex min-h-8 w-full items-center gap-2 rounded-control px-1.5 py-1 text-left transition-colors hover:bg-raised"
            onmouseenter={() => onHover(line.uci)}
            onmouseleave={() => onHover(null)}
            onfocus={() => onHover(line.uci)}
            onblur={() => onHover(null)}
          >
            <span class="w-3.5 shrink-0 text-[11px] text-muted tabular-nums">{i + 1}</span>
            <span class="min-w-11 shrink-0 rounded-control px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums {pillClass(line)}">
              {evalLabel(line.cp, line.mate)}
            </span>
            <span class="min-w-0 flex-1 truncate text-[13px] text-muted">
              <span class="font-bold text-text">{sans.first}</span>
              {#if sans.rest.length > 0}
                <span class="text-muted"> {sans.rest.join(" ")}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
      {#if lines.length > 3}
        <Button variant="ghost" size="sm" class="mt-0.5" onclick={() => (showAll = !showAll)}>
          {showAll ? "Show fewer" : `Show all ${lines.length}`}
        </Button>
      {/if}
    {:else}
      <p class="px-1.5 py-1.5 text-[12px] text-muted">No engine lines for this position.</p>
    {/if}
  </div>
</details>
