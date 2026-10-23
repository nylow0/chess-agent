<!--
  Player bar above or below the board: a colour chip, the username, the
  rating, and the material this player has captured (neutral silhouettes of
  the opponent's pieces plus the material lead when ahead), all on the left
  side of the bar. Placement (top/bottom of the board) comes from the `class`
  prop, which the parent grid uses.
-->
<script lang="ts">
  import type { CapturedSide } from "../chessUtils";
  import ColorChip from "./ColorChip.svelte";

  let {
    name,
    rating,
    color,
    captured,
    class: className = "",
  }: {
    name: string;
    rating: number | null;
    color: "white" | "black";
    captured: CapturedSide;
    class?: string;
  } = $props();

  // Must stay in sync with the piece set chosen in board.css.
  const roleFile = $derived(
    (role: string) => `/pieces/alpha/${color === "black" ? "b" : "w"}${role.toUpperCase()}.svg`,
  );
</script>

<!-- No horizontal padding of its own: the bar is grid-placed exactly over the
     board's columns, so the chip starts at the board's left edge. -->
<div class="flex h-10 items-center gap-2 overflow-hidden {className}">
  <!-- White = pure white, Black = dark grey with a light outline (ColorChip). -->
  <ColorChip white={color === "white"} />
  <span class="min-w-0 truncate text-[13px] font-semibold text-text">{name}</span>
  {#if rating !== null}
    <span class="shrink-0 text-[13px] text-muted tabular-nums">{rating}</span>
  {/if}
  <!-- Captured pieces sit right after the rating: silhouettes grouped by
       type (identical pieces overlap slightly, like Chess.com), then the
       material lead for whichever side is ahead. -->
  <span class="flex min-w-0 items-center overflow-hidden" aria-hidden="true">
    {#each captured.roles as role, i (i)}
      <span
        class="cap-piece {i > 0 && captured.roles[i - 1] === role ? '-ml-[5px]' : 'ml-px'}"
        style="-webkit-mask-image:url('{roleFile(role)}');mask-image:url('{roleFile(role)}')"
      ></span>
    {/each}
    {#if captured.lead !== null}
      <span class="ml-1.5 shrink-0 text-[13px] font-semibold text-muted tabular-nums">
        +{captured.lead}
      </span>
    {/if}
  </span>
</div>
