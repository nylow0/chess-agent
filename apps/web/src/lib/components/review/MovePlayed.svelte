<script lang="ts">
  import type { MoveAnalysis } from "@shared";
  import {
    CLASSIFICATION_COLOR,
    CLASSIFICATION_LABEL,
    isNotable,
    moverIsWhiteAtPly,
    winPercent,
  } from "../../chessUtils";
  import MoveBadge from "../MoveBadge.svelte";
  import Button from "../ui/Button.svelte";

  let {
    move,
    iAmWhite,
    onShowPosition,
  }: {
    move: MoveAnalysis;
    iAmWhite: boolean;
    onShowPosition: () => void;
  } = $props();

  const moverWhite = $derived(moverIsWhiteAtPly(move.ply));
  const mine = $derived(moverWhite === iAmWhite);
  const moveNumber = $derived(Math.floor((move.ply - 1) / 2) + 1);
  const prefix = $derived(moverWhite ? `${moveNumber}.` : `${moveNumber}...`);
  const notable = $derived(isNotable(move.classification));

  // Win chance is measured from the mover's side, before and after their loss.
  const fall = $derived.by(() => {
    if (!notable || move.cpBefore === null || move.cpl === null) return null;
    const cpBefore = moverWhite ? move.cpBefore : -move.cpBefore;
    return {
      from: Math.round(winPercent(cpBefore)),
      to: Math.round(winPercent(cpBefore - move.cpl)),
    };
  });
</script>

<section aria-label="Move played" class="flex items-start gap-3">
  <MoveBadge classification={move.classification} size={40} />
  <div class="min-w-0 flex-1">
    <p class="flex flex-wrap items-baseline gap-x-2">
      <span class="text-[20px] font-extrabold leading-tight tracking-tight text-text tabular-nums">
        {prefix} {move.san}
      </span>
      <span class="text-[13px] font-semibold {CLASSIFICATION_COLOR[move.classification] ?? ''}">
        {CLASSIFICATION_LABEL[move.classification]}
      </span>
      <span class="text-[12px] text-muted">{mine ? "your move" : "opponent's move"}</span>
    </p>

    {#if move.classification === "best"}
      <p class="mt-0.5 text-[13px] text-muted">This was the engine's first choice.</p>
    {:else if move.classification === "excellent" || move.classification === "good"}
      <p class="mt-0.5 text-[13px] text-muted">Close to the engine's first choice.</p>
    {:else if notable}
      {#if fall}
        <p class="mt-0.5 text-[13px] text-text">
          Win chance fell from <span class="tabular-nums">{fall.from}%</span> to
          <span class="tabular-nums">{fall.to}%</span>.
        </p>
      {/if}
      {#if move.bestMoveSan}
        <div class="mt-1 flex items-center justify-between gap-3">
          <p class="min-w-0 text-[13px] text-muted">
            The engine preferred <span class="font-semibold text-text">{move.bestMoveSan}</span>.
          </p>
          <Button
            variant="secondary"
            size="sm"
            class="h-8! min-h-8! shrink-0 px-2.5! text-[13px]!"
            onclick={onShowPosition}
          >
            Show that position
          </Button>
        </div>
      {/if}
    {/if}
  </div>
</section>
