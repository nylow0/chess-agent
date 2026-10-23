<!--
  Fixed bottom zone of the review panel: the five step controls, the mistake
  jumps and the ply counter. This zone never scrolls; the middle zone above
  it does, so the controls stay fully visible at every viewport height.
-->
<script lang="ts">
  import Button from "../ui/Button.svelte";

  let {
    currentPly,
    totalPlies,
    hasAnalysis,
    prevMistake,
    nextMistake,
    onGoTo,
    onFlip,
  }: {
    currentPly: number;
    totalPlies: number;
    /** Whether analysis is loaded; the mistake jumps only appear then. */
    hasAnalysis: boolean;
    prevMistake: number | null;
    nextMistake: number | null;
    onGoTo: (ply: number) => void;
    onFlip: () => void;
  } = $props();
</script>

{#snippet iconButton(
  label: string,
  path: "first" | "previous" | "next" | "last" | "flip",
  action: () => void,
  disabled: boolean,
)}
  <button
    type="button"
    {disabled}
    onclick={action}
    class="flex h-11 items-center justify-center rounded-control bg-raised text-text transition-colors hover:bg-line disabled:cursor-not-allowed disabled:opacity-[0.35]"
  >
    {#if path === "first"}
      <!-- Skip to start: a bar with a left-pointing triangle. -->
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path d="M4.5 4.5v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="M15.5 5.2v9.6L6.8 10z" fill="currentColor" />
      </svg>
    {:else if path === "previous"}
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path d="M14.5 5v10L5.8 10z" fill="currentColor" />
      </svg>
    {:else if path === "next"}
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path d="M5.5 5v10l8.7-5z" fill="currentColor" />
      </svg>
    {:else if path === "last"}
      <!-- Skip to end: a bar with a right-pointing triangle. -->
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path d="M15.5 4.5v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path d="M4.5 5.2v9.6L13.2 10z" fill="currentColor" />
      </svg>
    {:else}
      <!-- Flip board: two vertical arrows pointing in opposite directions. -->
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path
          d="M6.5 15.5v-11m0 0L4 7m2.5-2.5L9 7M13.5 4.5v11m0 0L11 13m2.5 2.5l2.5-2.5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {/if}
    <span class="sr-only">{label}</span>
  </button>
{/snippet}

<div data-controls class="controls shrink-0 px-3 pb-3 pt-2">
  <div class="grid grid-cols-5 gap-1.5">
    {@render iconButton("First move", "first", () => onGoTo(0), currentPly === 0)}
    {@render iconButton("Previous move", "previous", () => onGoTo(currentPly - 1), currentPly === 0)}
    {@render iconButton("Next move", "next", () => onGoTo(currentPly + 1), currentPly >= totalPlies)}
    {@render iconButton("Last move", "last", () => onGoTo(totalPlies), currentPly >= totalPlies)}
    {@render iconButton("Flip board", "flip", onFlip, false)}
  </div>
  <div class="mt-2 flex min-h-8 items-center gap-2">
    {#if hasAnalysis}
      <Button
        variant="secondary"
        size="sm"
        class="min-w-0 flex-1"
        disabled={prevMistake === null}
        onclick={() => {
          if (prevMistake !== null) onGoTo(prevMistake);
        }}
      >
        Previous mistake
      </Button>
      <Button
        variant="secondary"
        size="sm"
        class="min-w-0 flex-1"
        disabled={nextMistake === null}
        onclick={() => {
          if (nextMistake !== null) onGoTo(nextMistake);
        }}
      >
        Next mistake
      </Button>
    {/if}
    <span class="ml-auto shrink-0 text-[13px] text-muted tabular-nums">
      {currentPly} / {totalPlies}
    </span>
  </div>
  <p class="kbd-hint mt-1.5 hidden text-[12px] leading-4 text-muted lg:block">
    Arrow keys step through the game. Up and Down jump between your mistakes. F flips the board.
  </p>
</div>
