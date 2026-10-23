<!--
  Sign-in. The board and the form form one centred group (max 1180px, 72px
  gap), both vertically centred in the viewport. From 1024px the group is a
  row; the board side is min(72vh, 560px) and shrinks with the viewport, so
  at 1024x768 it still sits beside the 400px form. Below 1024px the board
  shrinks above the form and disappears on very short viewports. The board
  is a hand-picked real moment (LÃ©gal-style trap: after 3...Bg4?? the
  knight on f3 can take on e5), rendered exactly like the review board:
  blunder tint, ?? badge, orange engine arrow. It is decorative; the page
  gains no extra headings, links or buttons from it.
-->
<script lang="ts">
  import { Chess } from "chess.js";
  import { api, ApiError } from "../api";
  import { setUsername, markSynced } from "../store";
  import Board from "../components/Board.svelte";
  import BrandMark from "../components/BrandMark.svelte";
  import Button from "../components/ui/Button.svelte";
  import Notice from "../components/ui/Notice.svelte";

  // The example position is derived once with chess.js so FEN, blunder and
  // arrow stay consistent with each other.
  const example = (() => {
    const chess = new Chess();
    for (const san of ["e4", "e5", "Nf3", "d6", "Bc4", "Bg4"]) chess.move(san);
    return {
      fen: chess.fen(),
      // 3...Bg4?? pins the f3 knight; Nxe5! wins a pawn and opens the trap.
      blunderUci: "c8g4",
      bestUci: "f3e5",
    };
  })();

  let { onLogin }: { onLogin: () => void } = $props();

  let usernameInput = $state("");
  let phase = $state<"idle" | "signing" | "syncing">("idle");
  let error = $state<string | null>(null);

  // A pasted Chess.com profile URL is accepted as well as a bare username.
  function usernameFromInput(value: string): string {
    const trimmed = value.trim();
    const match = /(?:^|\/\/|\.)chess\.com\/member\/([^/?#\s]+)/i.exec(trimmed);
    return match ? match[1] : trimmed;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const name = usernameFromInput(usernameInput);
    if (!name || phase !== "idle") return;
    phase = "signing";
    error = null;
    try {
      const player = await api.login(name);
      phase = "syncing";
      await api.sync(player.username);
      // Mark the import as fresh so the Games screen does not sync again.
      markSynced(player.username);
      setUsername(player.username);
      phase = "idle";
      onLogin();
    } catch (err) {
      phase = "idle";
      error =
        err instanceof ApiError && err.status === 404
          ? `No Chess.com player named "${name}". Check the spelling.`
          : err instanceof ApiError
            ? err.message
            : "Could not reach the server. Try again.";
    }
  }
</script>

<main class="flex min-h-dvh items-center justify-center px-6 py-12">
  <!-- One centred group: board and form, 72px apart on desktop, both
       vertically centred. On desktop the group hugs its content (board +
       72px + 400px form, capped at 1180px); on phones it stacks. -->
  <div class="login-group flex flex-col items-center gap-10 lg:flex-row lg:gap-[72px]">
    <!-- The board square: min(72vh, 560px) on desktop, with a viewport cap
         so the group still fits beside the 400px form at 1024, and
         min(360px, 100%) on phones. Height follows the width through
         aspect-ratio. -->
    <div class="login-square overflow-hidden rounded-[var(--radius-board)]">
      <Board
        fen={example.fen}
        lastMoveUci={example.blunderUci}
        lastMoveQuality="blunder"
        bestMoveUci={example.bestUci}
        hoverUci={null}
        orientation="white"
        label="Decorative example: a middlegame position where Black's last bishop move blundered a piece"
      />
    </div>

    <!-- Brand and form in a 400px column. -->
    <div class="login-form">
      <BrandMark class="size-10 text-text" />
      <h1 class="mt-5 text-[40px] font-extrabold tracking-tight text-text">Post&#8209;mortem</h1>
      <p class="mt-3 text-base leading-relaxed text-muted">
        Pull your Chess.com games and see where the game slipped away, move by move.
      </p>

      <form onsubmit={submit} class="mt-10">
        <label class="block" for="username">
          <span class="mb-2 block text-sm font-semibold text-text">Chess.com username</span>
          <input
            id="username"
            type="text"
            autocomplete="username"
            spellcheck="false"
            bind:value={usernameInput}
            placeholder="hikaru"
            class="h-12 w-full rounded-control bg-raised px-4 text-base text-text placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
          />
        </label>

        {#if error}
          <div class="mt-3"><Notice tone="error">{error}</Notice></div>
        {/if}

        <Button
          type="submit"
          variant="primary"
          class="mt-6 h-12 w-full"
          loading={phase !== "idle"}
          disabled={!usernameInput.trim() || phase !== "idle"}
        >
          {phase === "idle"
            ? "Open my games"
            : phase === "signing"
              ? "Verifying player"
              : "Importing games"}
        </Button>
      </form>
    </div>
  </div>
</main>

<style>
  /* The centred group: full width (capped 1180px) on phones, hugging its
     content on desktop. */
  .login-group {
    width: 100%;
    max-width: 1180px;
  }

  /* The form column: full width up to 400px on phones, fixed 400px on
     desktop. */
  .login-form {
    width: 100%;
    max-width: 400px;
  }

  /* The board square: min(360px, 100%) on phones, min(72vh, 560px) on
     desktop -- the last min() term caps it to the space beside the 400px
     form and the 72px gap, so 1024x768 still fits the row. Height follows
     the width through aspect-ratio. */
  .login-square {
    width: min(360px, 100%);
    aspect-ratio: 1;
  }

  /* Very short landscape viewports: the board yields so the form is
      immediately reachable. */
  @media (max-width: 1023.98px) and (max-height: 560px) {
    .login-square {
      display: none;
    }
  }

  @media (min-width: 1024px) {
    .login-group {
      width: fit-content;
    }

    .login-form {
      width: 400px;
    }

    .login-square {
      width: min(72vh, 560px, calc(100vw - 520px));
    }
  }
</style>