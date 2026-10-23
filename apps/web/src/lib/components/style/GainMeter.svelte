<!--
  Gain over the engine baseline on a 0–4 point track. The marker at 2 shows the
  threshold the gate needs; the light bar is the measured gain.
-->
<script lang="ts">
  let { gainPp }: { gainPp: number } = $props();

  const clamped = $derived(Math.min(Math.max(gainPp, 0), 4));
  const percent = $derived((clamped / 4) * 100);
</script>

<div class="max-w-xl" role="img" aria-label={`Gain ${gainPp.toFixed(2)} points of the 2 needed`}>
  <div class="text-center text-xs text-muted">needed</div>
  <div class="relative mt-1 h-1.5 rounded-control bg-surface">
    <div class="absolute inset-y-0 left-0 rounded-control bg-text" style:width={`${percent}%`}></div>
    <div class="absolute -inset-y-1 left-1/2 w-px -translate-x-1/2 bg-muted"></div>
  </div>
  <div class="mt-1 grid grid-cols-3 text-xs tabular-nums text-muted">
    <span>0</span>
    <span class="text-center">2</span>
    <span class="text-right">4</span>
  </div>
</div>
