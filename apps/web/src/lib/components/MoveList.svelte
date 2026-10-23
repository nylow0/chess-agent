<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { GameAnalysis, MoveAnalysis } from "@shared";
  import {
    buildPlyRows,
    CLASSIFICATION_GLYPH,
    CLASSIFICATION_COLOR,
    isNotable,
    moverIsWhiteAtPly,
  } from "../chessUtils";
  import MoveBadge from "./MoveBadge.svelte";

  let {
    moves,
    analysis,
    currentPly,
    iAmWhite,
    onJump,
  }: {
    moves: string[];
    analysis: GameAnalysis | null;
    currentPly: number;
    iAmWhite: boolean;
    onJump: (ply: number) => void;
  } = $props();

  let listEl: HTMLDivElement | null = null;

  const rows = $derived(buildPlyRows(moves));

  // One lookup per analysis instead of scanning the move array for every cell.
  const byPly = $derived(new Map((analysis?.moves ?? []).map((m) => [m.ply, m])));

  const pairs = $derived.by(() => {
    const out: { number: number; white?: (typeof rows)[number]; black?: (typeof rows)[number] }[] =
      [];
    for (const row of rows) {
      if (row.white) out.push({ number: row.moveNumber, white: row });
      else {
        const last = out[out.length - 1];
        if (last && last.black === undefined) last.black = row;
        else out.push({ number: row.moveNumber, black: row });
      }
    }
    return out;
  });

  function cellClass(row: (typeof rows)[number], move: MoveAnalysis | undefined): string {
    const mine = moverIsWhiteAtPly(row.ply) === iAmWhite;
    // The current move is a block one step lighter than the panel; only the
    // three study-worthy grades otherwise get the classification colour.
    const colorClass =
      row.ply === currentPly
        ? "bg-[#333333] text-text"
        : move && isNotable(move.classification)
          ? (CLASSIFICATION_COLOR[move.classification] ?? "")
          : mine
            ? "text-text"
            : "text-muted";
    return [
      "flex min-h-8 flex-1 items-center gap-1.5 rounded-control px-2 py-1 text-left text-[14px] font-semibold transition-colors hover:bg-raised",
      colorClass,
    ].join(" ");
  }

  function glyphFor(ply: number): string {
    const move = byPly.get(ply);
    return move && isNotable(move.classification)
      ? (CLASSIFICATION_GLYPH[move.classification] ?? "")
      : "";
  }

  // The list scrolls inside the panel's move-list zone on desktop (the zone
  // has the scroll; the list has none); on mobile the list clips itself. Walk
  // up to the first ancestor that actually scrolls so the auto-scroll targets
  // the real clipping container.
  function scrollContainerOf(el: HTMLElement): HTMLElement {
    const scrollable = (node: HTMLElement) => {
      const overflow = getComputedStyle(node).overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    if (scrollable(el)) return el;
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
      if (scrollable(node)) return node;
      node = node.parentElement;
    }
    return el;
  }

  // The ply the scroll is currently kept for.
  let lastPly = 0;
  let scrollerEl: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;

  // Flex resizes of the scroll container (engine lines opening, viewport
  // changes) must re-apply the scroll, or the current move can fall out of
  // view while the box shrinks under it.
  function watchScroller(scroller: HTMLElement) {
    if (scroller === scrollerEl) return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      void tick().then(() => keepCurrentInView());
    });
    resizeObserver.observe(scroller);
    scrollerEl = scroller;
  }

  function keepCurrentInView() {
    const list = listEl;
    if (!list) return;
    const scroller = scrollContainerOf(list);
    watchScroller(scroller);
    const ply = lastPly;
    if (ply === 0) {
      scroller.scrollTop = 0;
      return;
    }
    const el = scroller.querySelector<HTMLElement>("[data-current='true']");
    if (!el) return;
    // Measure against the scroll container's viewport; never touch the page
    // scroll.
    const boxRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const pad = 12;
    const top = elRect.top - boxRect.top;
    const bottom = elRect.bottom - boxRect.top;
    if (top < pad) scroller.scrollTop += top - pad;
    else if (bottom > scroller.clientHeight - pad) {
      scroller.scrollTop += bottom - (scroller.clientHeight - pad);
    }
  }

  $effect(() => {
    // Track the current ply, the move rows and the analysis so the list
    // re-scrolls whenever any of them change.
    lastPly = currentPly;
    void rows.length;
    void byPly.size;
    void tick().then(() => keepCurrentInView());
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });
</script>

<div
  bind:this={listEl}
  class="max-h-[40vh] overflow-y-auto pr-1 lg:max-h-none lg:overflow-visible"
  aria-label="Moves"
>
  <div class="space-y-0.5 pb-3">
    {#each pairs as pair (pair.number)}
      {@const whiteMove = pair.white ? byPly.get(pair.white.ply) : undefined}
      {@const blackMove = pair.black ? byPly.get(pair.black.ply) : undefined}
      <div class="flex items-center gap-1">
        <span class="w-8 shrink-0 text-right text-[12px] text-muted tabular-nums">{pair.number}.</span>
        {#if pair.white}
          <button
            class={cellClass(pair.white, whiteMove)}
            data-current={pair.white.ply === currentPly}
            onclick={() => onJump(pair.white!.ply)}
          >
            {#if whiteMove && isNotable(whiteMove.classification)}
              <MoveBadge classification={whiteMove.classification} size={14} />
            {/if}
            <span class="min-w-0 truncate">{pair.white.san}</span>
            {#if glyphFor(pair.white.ply) && whiteMove}
              <span class="shrink-0 text-[12px] font-bold {CLASSIFICATION_COLOR[whiteMove.classification] ?? ''}">
                {glyphFor(pair.white.ply)}
              </span>
            {/if}
            <span class="flex-1"></span>
          </button>
        {:else}
          <span class="flex-1"></span>
        {/if}
        {#if pair.black}
          <button
            class={cellClass(pair.black, blackMove)}
            data-current={pair.black.ply === currentPly}
            onclick={() => onJump(pair.black!.ply)}
          >
            {#if blackMove && isNotable(blackMove.classification)}
              <MoveBadge classification={blackMove.classification} size={14} />
            {/if}
            <span class="min-w-0 truncate">{pair.black.san}</span>
            {#if glyphFor(pair.black.ply) && blackMove}
              <span class="shrink-0 text-[12px] font-bold {CLASSIFICATION_COLOR[blackMove.classification] ?? ''}">
                {glyphFor(pair.black.ply)}
              </span>
            {/if}
            <span class="flex-1"></span>
          </button>
        {:else}
          <span class="flex-1"></span>
        {/if}
      </div>
    {/each}
  </div>
</div>
