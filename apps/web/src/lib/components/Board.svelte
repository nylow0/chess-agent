<script lang="ts">
  import { onMount } from "svelte";
  import { Chessground } from "chessground";
  import type { Api } from "chessground/api";
  import type { DrawBrushes, DrawShape } from "chessground/draw";
  import type { Key } from "chessground/types";
  import { Chess } from "chess.js";
  import { uciToKeys, CLASSIFICATION_VAR } from "../chessUtils";
  import MoveBadge from "./MoveBadge.svelte";

  let {
    fen,
    lastMoveUci = null,
    /** Classification of the played move; tints its squares and draws a badge. */
    lastMoveQuality = null,
    bestMoveUci = null,
    personalMoveUci = null,
    hoverUci = null,
    orientation = "white",
    label = "Chess board",
  }: {
    fen: string;
    lastMoveUci: string | null;
    lastMoveQuality?: string | null;
    bestMoveUci: string | null;
    personalMoveUci?: string | null;
    hoverUci: string | null;
    orientation: "white" | "black";
    /** Accessible description of the current position. */
    label?: string;
  } = $props();

  let wrap: HTMLDivElement;
  let api: Api | null = null;

  // Chess.com-style arrows: chunky and semi-transparent. The engine's choice
  // is Chess.com's orange (#F5A623) so it reads on the green board; the style
  // suggestion keeps its blue and the hover preview stays white. The four
  // standard brushes are required by the type and unused in this view-only
  // board.
  const BRUSHES: DrawBrushes = {
    green: { key: "g", color: "#15781B", opacity: 1, lineWidth: 10 },
    red: { key: "r", color: "#882020", opacity: 1, lineWidth: 10 },
    blue: { key: "b", color: "#003088", opacity: 1, lineWidth: 10 },
    yellow: { key: "y", color: "#e68f00", opacity: 1, lineWidth: 10 },
    engine: { key: "engine", color: "#F5A623", opacity: 0.8, lineWidth: 12 },
    style: { key: "style", color: "#5B9BD5", opacity: 0.8, lineWidth: 12 },
    preview: { key: "preview", color: "#FFFFFF", opacity: 0.4, lineWidth: 12 },
  };

  function keysOf(uci: string): [Key, Key] | null {
    const keys = uciToKeys(uci);
    return keys ? [keys[0] as Key, keys[1] as Key] : null;
  }

  function validateFen(f: string): string {
    try {
      new Chess(f);
      return f;
    } catch {
      return new Chess().fen();
    }
  }

  const shapes = $derived.by(() => {
    const list: DrawShape[] = [];
    if (bestMoveUci) {
      const keys = keysOf(bestMoveUci);
      if (keys) list.push({ orig: keys[0], dest: keys[1], brush: "engine" });
    }
    if (personalMoveUci) {
      const keys = keysOf(personalMoveUci);
      if (keys) list.push({ orig: keys[0], dest: keys[1], brush: "style" });
    }
    if (hoverUci) {
      const keys = keysOf(hoverUci);
      if (keys) list.push({ orig: keys[0], dest: keys[1], brush: "preview" });
    }
    return list;
  });

  // Overlay marks for a played move with a known quality: its from/to squares
  // are tinted with the quality colour and a badge sits on the destination.
  // Percent positions follow the board orientation.
  function squarePos(square: string): { left: number; top: number } {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const col = orientation === "white" ? file : 7 - file;
    const row = orientation === "white" ? 7 - rank : rank;
    return { left: col * 12.5, top: row * 12.5 };
  }

  const marks = $derived.by(() => {
    if (!lastMoveUci || !lastMoveQuality) return null;
    const keys = uciToKeys(lastMoveUci);
    if (!keys) return null;
    const tint = CLASSIFICATION_VAR[lastMoveQuality] ?? "var(--color-muted)";
    return {
      tint,
      squares: keys.map((key) => squarePos(key)),
      // The badge is centred on the destination square's top-right corner,
      // clamped so it never leaves the board: on the top rank or the right
      // file it shifts fully inside the square's corner instead.
      badge: (() => {
        const pos = squarePos(keys[1]);
        const half = 2.125; // half of the badge's 4.25%-of-board width
        return {
          left: Math.min(100 - half, Math.max(half, pos.left + 12.5)),
          top: Math.min(100 - half, Math.max(half, pos.top)),
        };
      })(),
    };
  });

  // The arrow layers are decorative; the board's aria-label describes the position.
  // A flip rebuilds chessground's DOM, so re-hide the SVGs after every update.
  function hideDecorativeSvgs() {
    for (const svg of wrap.querySelectorAll("svg")) svg.setAttribute("aria-hidden", "true");
  }

  // Chessground's arrowhead marker is four times the shaft width, far heavier
  // than Chess.com's. Reshape every marker to Chess.com proportions: the head
  // is 2.5 shaft-widths wide and 0.9 of that long (the shaft itself is
  // brush.lineWidth / 64 of a square, about 19% at 12). Chessground ends the
  // line 10/64 of a square before the destination centre, so with the tip
  // minus the anchor point equalling 10/12 marker units the tip lands exactly
  // on the centre (marker units scale with the stroke width).
  function reshapeArrowheads() {
    for (const marker of wrap.querySelectorAll("marker")) {
      marker.setAttribute("refX", "2.25");
      marker.setAttribute("refY", "1.25");
      const path = marker.querySelector("path");
      if (path) path.setAttribute("d", "M0.8333,0 V2.5 L3.0833,1.25 Z");
    }
  }

  onMount(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    api = Chessground(wrap, {
      fen: validateFen(fen),
      viewOnly: true,
      coordinates: true,
      animation: { enabled: !reduceMotion, duration: 220 },
      movable: { free: false, showDests: false },
      drawable: { enabled: false, visible: true, brushes: BRUSHES },
    });
    hideDecorativeSvgs();
    reshapeArrowheads();
    // Chessground can create or recreate the brush markers after the first
    // render, so patch again whenever the DOM changes.
    const markerObserver = new MutationObserver(() => reshapeArrowheads());
    markerObserver.observe(wrap, { subtree: true, childList: true });
    return () => {
      markerObserver.disconnect();
      api?.destroy();
      api = null;
    };
  });

  // Apply the position and the decorative shapes together. A flip makes
  // chessground drop the drawn shapes during its redraw, so the shapes are
  // re-applied after every change.
  $effect(() => {
    if (!api) return;
    api.set({
      fen: validateFen(fen),
      // With a known quality the overlay draws the highlight instead, so the
      // plain-yellow chessground squares would double-tint.
      lastMove:
        lastMoveUci && !lastMoveQuality ? (keysOf(lastMoveUci) ?? undefined) : undefined,
      orientation,
    });
    api.setShapes(shapes);
    hideDecorativeSvgs();
  });
</script>

<div class="board-slot relative" role="img" aria-label={label}>
  <div bind:this={wrap} class="cg-mount"></div>
  {#if marks}
    <div class="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
      {#each marks.squares as square (square.left + "-" + square.top)}
        <div
          class="absolute"
          style="left:{square.left}%;top:{square.top}%;width:12.5%;height:12.5%;background-color:color-mix(in srgb, {marks.tint} 50%, transparent)"
        ></div>
      {/each}
      <div class="board-badge" style="left:{marks.badge.left}%;top:{marks.badge.top}%">
        <MoveBadge classification={lastMoveQuality!} size={null} />
      </div>
    </div>
  {/if}
</div>
