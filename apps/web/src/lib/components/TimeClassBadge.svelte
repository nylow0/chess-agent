<!--
  Time-class label: an inline-SVG icon per class (bullet and blitz share the
  lightning bolt, rapid a clock, daily a calendar) plus the class name in
  muted 13px. Neutral by design: the only colour on screen is chess meaning.
-->
<script lang="ts">
  import type { GameSummary } from "@shared";

  let { timeClass }: { timeClass: GameSummary["timeClass"] } = $props();
</script>

<span class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] capitalize text-muted">
  {#if timeClass === "bullet" || timeClass === "blitz"}
    <!-- Lightning bolt. -->
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" aria-hidden="true">
      <path d="M8.8 1.5 3.5 9h3.2l-.8 5.5L11.5 7H8.3l.5-5.5z" fill="currentColor" />
    </svg>
  {:else if timeClass === "rapid"}
    <!-- Clock face. -->
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {:else}
    <!-- Daily: calendar page. -->
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.5" />
      <path d="M2.25 6.75h11.5M5.25 1.75v2.5M10.75 1.75v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  {/if}
  <span class="min-w-0">{timeClass}</span>
</span>
