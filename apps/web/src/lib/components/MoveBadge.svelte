<!--
  Move-quality badge: a coloured disc with a thin dark outline and a white
  glyph, drawn as one SVG so it renders identically in the move list, the
  move-played card, the summary counts and on the board (where it is sized
  with CSS percentages by .board-badge). Glyphs: best = star, excellent =
  double check, good = check, book = open book, and ?! / ? / ?? for the
  three study-worthy grades. Everything is drawn with paths, never text
  nodes, so badges never leak characters into a parent's textContent.
-->
<script lang="ts">
  import { CLASSIFICATION_VAR } from "../chessUtils";

  let {
    classification,
    size = 16,
  }: {
    classification: string;
    /** Diameter in CSS pixels; omit for the CSS-sized board variant. */
    size?: number | null;
  } = $props();

  const disc = $derived(CLASSIFICATION_VAR[classification] ?? "var(--color-muted)");
</script>

<svg
  viewBox="0 0 24 24"
  class="shrink-0 select-none {size === null ? 'size-full' : ''}"
  width={size === null ? undefined : size}
  height={size === null ? undefined : size}
  aria-hidden="true"
>
  <circle cx="12" cy="12" r="10.4" fill={disc} stroke="#101010" stroke-width="1.3" />
  {#if classification === "best"}
    <path
      d="M12 4.1l2 4.2 4.6.6-3.4 3.2.9 4.5-4.1-2.3-4.1 2.3.9-4.5-3.4-3.2 4.6-.6 2-4.2z"
      fill="#fff"
    />
  {:else if classification === "excellent"}
    <path
      d="M4.4 12.9l3.1 3.1 2.9-3.1M10.2 12.9l3.3 3.3 6.6-7.2"
      fill="none"
      stroke="#fff"
      stroke-width="2.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else if classification === "good"}
    <path
      d="M5.4 12.6l4.3 4.4 8.9-9.8"
      fill="none"
      stroke="#fff"
      stroke-width="2.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else if classification === "book"}
    <path
      d="M12 7c-1.7-1.3-4-1.5-6-.8v9.7c2-.7 4.3-.5 6 .8 1.7-1.3 4-1.5 6-.8V6.2c-2-.7-4.3-.5-6 .8z
         M12 7v9.7"
      fill="#fff"
      fill-rule="evenodd"
    />
  {:else if classification === "mistake"}
    <!-- A single question mark, drawn as a stroke so it stays crisp at any size. -->
    <g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">
      <path d="M9.2 9.4a2.9 2.9 0 1 1 4.6 2.4c-.9.6-1.6 1.2-1.6 2.4" />
    </g>
    <circle cx="12.1" cy="17.6" r="1.5" fill="#fff" />
  {:else if classification === "inaccuracy"}
    <!-- "?!" side by side. -->
    <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
      <path d="M6.2 9.8a2.5 2.5 0 1 1 4 2.1c-.8.5-1.4 1-1.4 2" />
      <path d="M16.7 7.4v6" />
    </g>
    <circle cx="8.9" cy="17.4" r="1.4" fill="#fff" />
    <circle cx="16.7" cy="16.6" r="1.4" fill="#fff" />
  {:else}
    <!-- "??" side by side. -->
    <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
      <path d="M5.4 9.6a2.4 2.4 0 1 1 3.8 2c-.7.5-1.3 1-1.3 1.9" />
      <path d="M13.6 9.6a2.4 2.4 0 1 1 3.8 2c-.7.5-1.3 1-1.3 1.9" />
    </g>
    <circle cx="7.8" cy="16.9" r="1.4" fill="#fff" />
    <circle cx="16" cy="16.9" r="1.4" fill="#fff" />
  {/if}
</svg>
