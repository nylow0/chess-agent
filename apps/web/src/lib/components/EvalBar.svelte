<script lang="ts">
  import { winChance, evalLabel } from "../chessUtils";

  let {
    cp,
    mate,
    pending = false,
    orientation = "white",
  }: {
    cp: number | null;
    mate: number | null;
    pending?: boolean;
    orientation?: "white" | "black";
  } = $props();

  const whitePct = $derived(pending ? 50 : winChance(cp, mate));
  const label = $derived(pending ? "–" : evalLabel(cp, mate));

  // The label sits inside the bar at the end belonging to the side that is
  // ahead: in the white portion (dark text) or the dark portion (light text).
  // An even score is shown at White's end.
  const whiteAhead = $derived(
    pending
      ? true
      : mate !== null
        ? (mate === 0 ? (cp ?? 0) > 0 : mate > 0)
        : (cp ?? 0) >= 0,
  );

  // White's share sits at the bottom when White is at the bottom, and at the
  // top when flipped, so the label follows the same end.
  const labelAtBottom = $derived(orientation === "white" ? whiteAhead : !whiteAhead);
  const labelOnWhite = $derived(whiteAhead);
</script>

<div class="relative h-full w-full overflow-hidden rounded-board bg-[#333333]">
  <div
    class="absolute inset-x-0 bg-white motion-safe:transition-[height] motion-safe:duration-300 motion-safe:ease-out {orientation ===
    "white"
      ? "bottom-0"
      : "top-0"}"
    style="height: {whitePct}%"
  ></div>
  <span
    data-eval-label
    class="absolute inset-x-0 whitespace-nowrap text-center text-[9px] font-bold leading-none tabular-nums lg:text-[11px] {labelAtBottom
      ? "bottom-0.5"
      : "top-0.5"} {labelOnWhite ? 'text-[#333333]' : 'text-[#f4f4f4]'}"
  >
    {label}
  </span>
</div>
