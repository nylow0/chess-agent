<script lang="ts">
  import type { MoveAnalysis } from "@shared";
  import { winChance, isNotable, moverIsWhiteAtPly, CLASSIFICATION_LABEL } from "../../chessUtils";

  let {
    moves,
    currentPly,
    iAmWhite,
    onJump,
  }: {
    moves: MoveAnalysis[];
    currentPly: number;
    iAmWhite: boolean;
    onJump: (ply: number) => void;
  } = $props();

  const height = 64;
  // Horizontal inset so the start/end markers and edge dots stay visible.
  const inset = 4;
  let width = $state(0);
  let svgEl = $state<SVGSVGElement>();
  let dragging = false;

  const total = $derived(moves.length);

  // One point per position, from the start (ply 0) to the final position.
  const points = $derived.by(() => {
    const out: { ply: number; pct: number }[] = [];
    for (let p = 0; p <= total; p++) {
      if (p === 0) {
        out.push({
          ply: 0,
          pct: winChance(moves[0]?.cpBefore ?? null, moves[0]?.mateBefore ?? null),
        });
      } else {
        const move = moves[p - 1];
        out.push({ ply: p, pct: winChance(move.cpAfter, move.mateAfter) });
      }
    }
    return out;
  });

  function xOf(ply: number): number {
    if (total === 0) return inset;
    return inset + (ply / total) * (width - 2 * inset);
  }

  function yOf(pct: number): number {
    return height - (pct / 100) * height;
  }

  const curve = $derived(
    points.map((point) => `${xOf(point.ply).toFixed(1)},${yOf(point.pct).toFixed(1)}`).join(" "),
  );

  const area = $derived(`${inset},${height} ${curve} ${width - inset},${height}`);

  const markers = $derived.by(() =>
    moves
      .filter(
        (move) => isNotable(move.classification) && moverIsWhiteAtPly(move.ply) === iAmWhite,
      )
      .map((move) => ({
        ply: move.ply,
        x: xOf(move.ply),
        y: yOf(winChance(move.cpAfter, move.mateAfter)),
        classification: move.classification,
      })),
  );

  const markerColor: Record<string, string> = {
    inaccuracy: "var(--color-cls-inaccuracy)",
    mistake: "var(--color-cls-mistake)",
    blunder: "var(--color-cls-blunder)",
  };

  const currentPct = $derived(points[currentPly]?.pct ?? 50);
  const ariaText = $derived(
    currentPly === 0
      ? "Start position"
      : `Move ${Math.ceil(currentPly / 2)}, White ${Math.round(currentPct)}%`,
  );

  function jumpAt(clientX: number) {
    if (!svgEl || total === 0) return;
    const rect = svgEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - inset) / (rect.width - 2 * inset)));
    onJump(Math.round(ratio * total));
  }

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    svgEl?.setPointerCapture(event.pointerId);
    jumpAt(event.clientX);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragging) jumpAt(event.clientX);
  }

  function onPointerUp(event: PointerEvent) {
    dragging = false;
    svgEl?.releasePointerCapture(event.pointerId);
  }

  function onKeydown(event: KeyboardEvent) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = currentPly + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = currentPly - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = total;
        break;
      default:
        return;
    }
    event.preventDefault();
    // Keep the window-level stepper from handling the same key twice.
    event.stopPropagation();
    onJump(Math.max(0, Math.min(total, next)));
  }
</script>

<div class="w-full rounded-control bg-raised" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      bind:this={svgEl}
      width={width}
      height={height}
      viewBox="0 0 {width} {height}"
      role="slider"
      tabindex="0"
      aria-label="Game timeline"
      aria-valuemin="0"
      aria-valuemax={total}
      aria-valuenow={currentPly}
      aria-valuetext={ariaText}
      aria-describedby="eval-graph-caption"
      class="block touch-none cursor-pointer"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onkeydown={onKeydown}
    >
      <polygon points={area} fill="var(--color-text)" opacity="0.9" />
      <line
        x1="0"
        y1={height / 2}
        x2={width}
        y2={height / 2}
        stroke="#3d3d3d"
        stroke-width="1"
      />
      {#each markers as marker (marker.ply)}
        <circle
          cx={marker.x}
          cy={marker.y}
          r="3"
          fill={markerColor[marker.classification]}
          stroke="#101010"
          stroke-width="1"
        >
          <title>Move {Math.ceil(marker.ply / 2)}: {CLASSIFICATION_LABEL[marker.classification]}</title>
        </circle>
      {/each}
      <!-- Current position: a white line with a dark outline so it reads over
           both the white area and the dark background. -->
      <line
        x1={xOf(currentPly)}
        y1="0"
        x2={xOf(currentPly)}
        y2={height}
        stroke="#101010"
        stroke-width="4"
      />
      <line
        x1={xOf(currentPly)}
        y1="0"
        x2={xOf(currentPly)}
        y2={height}
        stroke="#ffffff"
        stroke-width="2"
      />
      <circle
        cx={xOf(currentPly)}
        cy={yOf(currentPct)}
        r="3"
        fill="#ffffff"
        stroke="#101010"
        stroke-width="1.5"
      />
    </svg>
  {/if}
</div>

<!-- The caption stays in the DOM for assistive technology (wired to the
     slider with aria-describedby) but is visually hidden: it cost two lines
     of the panel's most valuable space. -->
<p id="eval-graph-caption" class="sr-only">
  Winning chances through the game. The light area is White. Dots mark your mistakes.
</p>
