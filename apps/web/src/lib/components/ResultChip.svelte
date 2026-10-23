<!--
  Result mark: a 22px rounded square in the result colour with a white glyph
  (+ / − / =) and the result word beside it. `data-testid` never needed; the
  word is real text so tests and screen readers both read "Won"/"Lost"/"Draw".
-->
<script lang="ts">
  let {
    result,
  }: { result: "win" | "loss" | "draw" } = $props();

  const square = {
    win: "bg-win",
    loss: "bg-loss",
    draw: "bg-draw",
  } as const;

  const word = {
    win: "text-win",
    loss: "text-loss",
    draw: "text-muted",
  } as const;

  const labels = { win: "Won", loss: "Lost", draw: "Draw" } as const;
</script>

<span class="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold {word[result]}">
  <span
    class="flex size-[22px] items-center justify-center rounded-[6px] {square[result]}"
    aria-hidden="true"
  >
    <svg viewBox="0 0 12 12" class="size-2.5 text-white" fill="none" aria-hidden="true">
      {#if result === "win"}
        <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      {:else if result === "loss"}
        <path d="M1.5 6h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      {:else}
        <path d="M2.2 4.2h7.6M2.2 7.8h7.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      {/if}
    </svg>
  </span><span>{labels[result]}</span>
</span>
