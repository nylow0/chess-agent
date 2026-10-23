<!--
  Accuracy blocks and the counts line. The block of whoever played White is
  light with dark text; the Black block is dark with light text, like
  Chess.com's accuracy boxes. The counts line keeps the exact text format the
  tests pin ("1 blunder, 2 inaccuracies" / "No mistakes"); the badges before
  each count are pure SVG paths and add no text.
-->
<script lang="ts">
  import type { GameAnalysis, MoveAnalysis } from "@shared";
  import { CLASSIFICATION_VAR, CLASSIFICATION_LABEL } from "../../chessUtils";
  import MoveBadge from "../MoveBadge.svelte";

  let { summary, iAmWhite }: { summary: GameAnalysis["summary"]; iAmWhite: boolean } = $props();

  const kinds: MoveAnalysis["classification"][] = ["blunder", "mistake", "inaccuracy"];

  const countItems = $derived(
    kinds
      .map((kind) => ({ kind, count: summary.counts[kind] ?? 0 }))
      .filter((item) => item.count > 0),
  );

  const PLURAL_LABELS: Partial<Record<MoveAnalysis["classification"], string>> = {
    blunder: "blunders",
    mistake: "mistakes",
    inaccuracy: "inaccuracies",
  };

  function plural(kind: MoveAnalysis["classification"], count: number): string {
    if (count === 1) return CLASSIFICATION_LABEL[kind].toLowerCase();
    return PLURAL_LABELS[kind] ?? `${CLASSIFICATION_LABEL[kind].toLowerCase()}s`;
  }
</script>

<div class="grid grid-cols-2 gap-2">
  <div
    class="acc-block rounded-control px-3 py-2.5 {iAmWhite ? 'bg-text' : 'bg-raised'}"
  >
    <p class="acc-num text-[28px] font-extrabold leading-none tracking-tight tabular-nums {iAmWhite ? 'text-bg' : 'text-text'}">
      {summary.myAccuracy.toFixed(1)}%
    </p>
    <p class="acc-label mt-1.5 text-[12px] font-semibold {iAmWhite ? 'text-[#666666]' : 'text-muted'}">
      Your accuracy
    </p>
  </div>
  <div class="acc-block rounded-control px-3 py-2.5 {iAmWhite ? 'bg-raised' : 'bg-text'}">
    <p class="acc-num text-[28px] font-extrabold leading-none tracking-tight tabular-nums {iAmWhite ? 'text-text' : 'text-bg'}">
      {summary.opponentAccuracy.toFixed(1)}%
    </p>
    <p class="acc-label mt-1.5 text-[12px] font-semibold {iAmWhite ? 'text-muted' : 'text-[#666666]'}">
      Opponent accuracy
    </p>
  </div>
</div>

<p class="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted" data-summary>
  {#if countItems.length === 0}
    No mistakes
  {:else}
    {#each countItems as item, i (item.kind)}
      <span class="inline-flex items-center gap-1">
        <MoveBadge classification={item.kind} size={14} />
        <!-- The count, label and separator live in one text run so the exact
             text the tests pin is stable. -->
        <span class="tabular-nums">{item.count} {plural(item.kind, item.count)}{i < countItems.length - 1 ? ", " : ""}</span>
      </span>
    {/each}
  {/if}
</p>
