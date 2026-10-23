<!--
  Single-choice segmented control. Wraps a radiogroup; Left/Right (and Up/Down)
  move the selection and only the selected segment is in the tab order.
  `options[].count` is shown after the label. `value` is bindable.
-->
<script module lang="ts">
  export interface SegmentedOption {
    value: string;
    label: string;
    count?: number;
  }
</script>

<script lang="ts">
  let {
    options,
    value = $bindable(""),
    label,
  }: {
    options: SegmentedOption[];
    value: string;
    label: string;
  } = $props();

  let groupEl: HTMLDivElement | null = null;

  function move(delta: number) {
    const index = options.findIndex((option) => option.value === value);
    const next = (index + delta + options.length) % options.length;
    value = options[next].value;
    groupEl?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  }
</script>

<div
  bind:this={groupEl}
  role="radiogroup"
  aria-label={label}
  class="inline-flex max-w-full flex-wrap rounded-control bg-raised p-1"
>
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === option.value}
      tabindex={value === option.value ? 0 : -1}
      class="flex h-8 items-center rounded-control px-3 text-sm font-medium transition-colors {value ===
      option.value
        ? 'bg-[#333333] text-text'
        : 'text-muted hover:text-text'}"
      onclick={() => (value = option.value)}
      onkeydown={onKeydown}
    >
      {option.label}
      {#if option.count !== undefined}
        <span class="ml-1.5 text-muted tabular-nums">{option.count}</span>
      {/if}
    </button>
  {/each}
</div>
