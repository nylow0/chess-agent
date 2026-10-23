<script lang="ts">
  import { gamesState, resetFilters, type GameSort } from "../../gamesState.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Button from "../ui/Button.svelte";

  let {
    timeOptions,
    hasFilters,
  }: {
    timeOptions: { value: string; label: string; count?: number }[];
    hasFilters: boolean;
  } = $props();

  const resultOptions = [
    { value: "all", label: "All" },
    { value: "win", label: "Won" },
    { value: "loss", label: "Lost" },
    { value: "draw", label: "Draw" },
  ];

  const sortOptions: { value: GameSort; label: string }[] = [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
    { value: "accuracy-asc", label: "Lowest accuracy" },
    { value: "accuracy-desc", label: "Highest accuracy" },
    { value: "blunders", label: "Most blunders" },
  ];

  /* Every control in the row is 40px tall, 6px radius, raised fill, no border. */
  const field =
    "h-10 rounded-control bg-raised text-sm text-text placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";
</script>

<div class="flex flex-wrap items-center gap-3">
  <div class="relative w-full sm:w-64">
    <svg
      viewBox="0 0 16 16"
      class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.6" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
    <input
      type="search"
      aria-label="Search games"
      placeholder="Search opponent or opening"
      bind:value={gamesState.search}
      class="{field} w-full pl-9 pr-3"
    />
  </div>

  <Segmented label="Time control" options={timeOptions} bind:value={gamesState.timeClass} />

  <Segmented label="Result" options={resultOptions} bind:value={gamesState.result} />

  <div class="relative">
    <select
      aria-label="Sort"
      value={gamesState.sort}
      onchange={(event) => (gamesState.sort = event.currentTarget.value as GameSort)}
      class="{field} appearance-none py-0 pl-3 pr-9"
    >
      {#each sortOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <svg
      viewBox="0 0 16 16"
      class="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted"
      fill="none"
      aria-hidden="true"
    >
      <path d="m4 6.5 4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </div>

  {#if hasFilters}
    <Button variant="ghost" size="sm" onclick={resetFilters}>Clear filters</Button>
  {/if}
</div>
