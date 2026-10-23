<script lang="ts">
  import type { MoveAnalysis, Recommendation } from "@shared";
  import {
    CLASSIFICATION_COLOR,
    CLASSIFICATION_LABEL,
    moverIsWhiteAtPly,
  } from "../../chessUtils";
  import Notice from "../ui/Notice.svelte";

  let {
    move,
    iAmWhite,
    recommendation,
    recommending,
    recommendationError,
    tolerance = $bindable(30),
    preferenceOnly = $bindable(true),
    onNext,
    onRetry,
  }: {
    move: MoveAnalysis;
    iAmWhite: boolean;
    recommendation: Recommendation | null;
    recommending: boolean;
    recommendationError: string | null;
    tolerance: number;
    preferenceOnly: boolean;
    onNext: () => void;
    onRetry: () => void;
  } = $props();

  const mine = $derived(moverIsWhiteAtPly(move.ply) === iAmWhite);
  const tolerancePawns = $derived(`${(tolerance / 100).toFixed(2)} pawns`);
</script>

<section aria-label="Next move" class="space-y-2">
  <!-- The swatches match the board arrows: engine orange, style blue. -->
  <p class="flex items-center gap-2 text-[13px]">
    <span class="size-2.5 shrink-0 rounded-[3px] bg-[#F5A623]" aria-hidden="true"></span>
    <span class="text-muted">Engine's choice</span>
    <span class="font-semibold text-text">{move.bestMoveSan ?? "–"}</span>
  </p>

  <button
    class="flex min-h-9 w-full items-center gap-2 rounded-control bg-raised px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-line"
    onclick={onNext}
  >
    <span class="shrink-0 text-muted">{mine ? "You played" : "Opponent played"}</span>
    <span class="min-w-0 truncate font-semibold text-text">{move.san}</span>
    <span class="ml-auto shrink-0 font-semibold {CLASSIFICATION_COLOR[move.classification] ?? ''}">
      {CLASSIFICATION_LABEL[move.classification]}
    </span>
  </button>

  {#if mine}
    {#if recommendationError}
      <Notice tone="error" {onRetry}>{recommendationError}</Notice>
    {/if}
    {#if recommendation?.forYou}
      <div class="rounded-control bg-raised p-2.5">
        <p class="flex items-center gap-2 text-[13px]">
          <span class="size-2.5 shrink-0 rounded-[3px] bg-[#5B9BD5]" aria-hidden="true"></span>
          <span class="text-muted">Your style</span>
          <span class="font-semibold text-text">{recommendation.forYou.san}</span>
        </p>
        <p class="mt-1 text-[12px] leading-4 text-muted">{recommendation.reason}</p>
        <details class="mt-1.5">
          <summary class="inline-flex min-h-8 cursor-pointer select-none items-center text-[12px] font-semibold text-muted hover:text-text">
            Adjust
          </summary>
          <label class="mt-2 block text-[13px] text-muted">
            <span class="flex justify-between">
              <span>Style tolerance</span>
              <span class="text-text tabular-nums">{tolerancePawns}</span>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              bind:value={tolerance}
              class="mt-1 w-full"
              aria-label="Style tolerance"
            />
          </label>
          <p class="mt-1 text-[12px] leading-4 text-muted">
            How much worse than the engine's choice a suggestion may be.
          </p>
          <label class="mt-2 flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              bind:checked={preferenceOnly}
              class="size-3.5"
              aria-label="Preference only"
            />
            Preference only
          </label>
          <p class="mt-1 text-[12px] leading-4 text-muted">
            Rank only by your past choices. Turn off to also weigh the positions you tend to play
            well, which is experimental.
          </p>
        </details>
      </div>
    {:else if recommending}
      <p class="text-[12px] text-muted">Checking your style…</p>
    {:else if !recommendationError}
      <p class="text-[12px] leading-4 text-muted">
        {recommendation?.reason ?? "No suggestion yet."}
        <a
          href="#/style"
          class="inline-flex min-h-8 items-center font-semibold text-text hover:underline lg:min-h-0"
        >
          About your style
        </a>
      </p>
    {/if}
    {#if recommending && recommendation?.forYou}
      <p class="text-[12px] text-muted">Checking your style…</p>
    {/if}
  {/if}
</section>
