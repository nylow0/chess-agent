<!--
  Side chip beside a player's name: White = pure white, Black = dark grey
  with a light outline so both read on the black page. Shared by the review
  player bar and the games list so the two can never drift apart.
-->
<script lang="ts">
  let { white, label }: { white: boolean; label?: string } = $props();
</script>

<span
  class="inline-block size-3 shrink-0 rounded-[3px] {white
    ? 'bg-white'
    : 'border border-[#777777] bg-[#333333]'}"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
></span>
