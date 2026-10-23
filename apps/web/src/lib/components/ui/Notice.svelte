<!--
  Inline message block: a surface panel with a 3px left bar in the tone
  colour. `tone` picks the bar colour; errors announce via role="alert".
  Pass `onRetry` to offer a secondary "Try again" action.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";

  let {
    tone,
    onRetry,
    children,
  }: {
    tone: "error" | "info" | "success";
    onRetry?: () => void;
    children?: Snippet;
  } = $props();

  const tones = {
    error: "border-l-loss",
    info: "border-l-muted",
    success: "border-l-win",
  } as const;
</script>

<div
  class="fade-in rounded-panel border-l-[3px] bg-surface px-5 py-4 {tones[tone]}"
  role={tone === "error" ? "alert" : "status"}
>
  <div class="text-sm">{@render children?.()}</div>
  {#if onRetry}
    <Button class="mt-3" onclick={onRetry}>Try again</Button>
  {/if}
</div>
