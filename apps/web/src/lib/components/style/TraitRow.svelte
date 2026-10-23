<!--
  One tendency: the sign-based name and explanation on the left, the strength
  bar in the middle, and up to three example chips on the right. The bar is
  8px, #F4F4F4 fill on a raised track, and every row's bar shares the same
  grid column so left edges and widths align across rows.
-->
<script lang="ts">
  import type { StyleTrait } from "@shared";
  import { traitCopy } from "./traitCopy";

  let { trait, maxPreference }: { trait: StyleTrait; maxPreference: number } = $props();

  const copy = $derived(trait.preference >= 0 ? traitCopy[trait.feature].positive : traitCopy[trait.feature].negative);
  const strength = $derived(maxPreference > 0 ? Math.round((Math.abs(trait.preference) / maxPreference) * 100) : 0);
  const pawns = $derived(((Math.abs(trait.performanceCp ?? 0)) / 100).toFixed(1));

  // ply counts the half-moves before the example move: even => White to move ("N."), odd => Black ("N...").
  function moveLabel(ply: number, san: string): string {
    return `${Math.floor(ply / 2) + 1}${ply % 2 ? "..." : "."} ${san}`;
  }
</script>

<article
  class="grid gap-4 py-3 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)_280px] lg:gap-10"
  data-testid="trait-row"
>
  <div>
    <h3 class="text-[16px] font-bold text-text">{copy.name}</h3>
    <p class="mt-1 text-[13px] text-muted">{copy.sentence}</p>
  </div>
  <div>
    <div class="flex h-7 items-center">
      <div class="h-2 w-full rounded-[4px] bg-raised" role="img" aria-label={`Strength ${strength} of 100`}>
        <div class="h-full rounded-[4px] bg-text" style:width={`${strength}%`}></div>
      </div>
    </div>
    {#if trait.performanceCp !== null}
      <p class="mt-2 text-[13px] text-muted">
        {trait.performanceCp >= 0
          ? `Your following moves are stronger after this: about ${pawns} pawns less lost over the next ten moves.`
          : `Your following moves are weaker after this: about ${pawns} pawns more lost over the next ten moves.`}
      </p>
    {/if}
  </div>
  <div>
    <p class="text-[13px] text-muted">Examples</p>
    <div class="mt-2 flex flex-wrap gap-2 lg:flex-nowrap lg:justify-start">
      {#each trait.examples as example, i}
        <a
          href={`#/game/${example.gameUuid}?ply=${example.ply}&from=style`}
          class="inline-flex min-h-8 items-center rounded-control bg-raised px-2 text-[13px] font-semibold text-text transition-colors hover:bg-line"
          aria-label={`Review ${copy.name} example ${i + 1}`}
        >{moveLabel(example.ply, example.san)}</a>
      {/each}
    </div>
  </div>
</article>
