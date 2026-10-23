<!--
  The analysis queue as a Notice-style block: surface fill, 3px muted left
  bar, count, 4px progress bar and the Stop button.
-->
<script lang="ts">
  import Button from "../ui/Button.svelte";

  let {
    left,
    progress,
    stopping,
    onStop,
  }: {
    left: number;
    progress: number;
    stopping: boolean;
    onStop: () => void;
  } = $props();

  const percent = $derived(Math.round(Math.max(0, Math.min(1, progress)) * 100));
</script>

<div class="fade-in rounded-panel border-l-[3px] border-l-muted bg-surface px-5 py-4" data-testid="queue-banner">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <p class="text-sm text-text" role="status">Analyzing your games. {left} left, a few minutes each.</p>
    <Button size="sm" class="ml-auto" loading={stopping} onclick={onStop}>Stop</Button>
  </div>
  <div
    class="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-raised"
    role="progressbar"
    aria-label="Analysis progress"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={percent}
  >
    <div class="h-full bg-text transition-[width]" style={`width: ${percent}%`}></div>
  </div>
</div>
