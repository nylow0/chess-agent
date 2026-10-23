<!--
  Brand mark: the tilted king. One source for the rail and the sign-in page
  so the two always render the same glyph, crisp at any size.
-->
<script lang="ts">
  let { class: className = "" }: { class?: string } = $props();
</script>

<svg viewBox="0 0 24 24" class={className} fill="currentColor" aria-hidden="true">
  <g transform="rotate(12 12 12)">
    <path d="M11.2 1.6h1.6v2h2v1.6h-2v1.7l3.5 3.2a4.7 4.7 0 0 1 1.4 4.9l-.6 1.9H6.9l-.6-1.9a4.7 4.7 0 0 1 1.4-4.9l3.5-3.2V5.2h-2V3.6h2v-2z" />
    <rect x="5.6" y="18.2" width="12.8" height="2.4" rx="1.2" />
  </g>
</svg>
