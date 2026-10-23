<script lang="ts">
  import { onMount } from "svelte";
  import type { GameAnalysis, GameDetail, Recommendation } from "@shared";
  import { api, ApiError, type AnalysisStatus } from "../api";
  import { username } from "../store";
  import { navigate, route } from "../router.svelte";
  import {
    moverIsWhite as isWhiteSide,
    moverIsWhiteAtPly,
    myResult,
    uciAtPly,
    isNotable,
    pgnTermination,
    capturedSummary,
  } from "../chessUtils";
  import Board from "../components/Board.svelte";
  import EvalBar from "../components/EvalBar.svelte";
  import MoveList from "../components/MoveList.svelte";
  import EngineLines from "../components/EngineLines.svelte";
  import PlayerBar from "../components/PlayerBar.svelte";
  import Spinner from "../components/ui/Spinner.svelte";
  import Button from "../components/ui/Button.svelte";
  import Notice from "../components/ui/Notice.svelte";
  import GameSummary from "../components/review/GameSummary.svelte";
  import EvalGraph from "../components/review/EvalGraph.svelte";
  import MovePlayed from "../components/review/MovePlayed.svelte";
  import NextMove from "../components/review/NextMove.svelte";
  import PanelHeader from "../components/review/PanelHeader.svelte";
  import PanelControls from "../components/review/PanelControls.svelte";

  let {
    uuid,
    initialPly = 0,
  }: {
    uuid: string;
    initialPly?: number;
  } = $props();

  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  let game = $state<GameDetail | null>(null);
  let analysis = $state<GameAnalysis | null>(null);
  let analysisStatus = $state<AnalysisStatus | "loading">("loading");
  let analysisError = $state<string | null>(null);
  // True when the analysis request itself failed, so "Try again" refetches
  // instead of queueing the game for analysis.
  let analysisLoadFailed = $state(false);
  let currentPly = $state(0);
  let orientation = $state<"white" | "black">("white");
  let hoverUci = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let tolerance = $state(30);
  let preferenceOnly = $state(true);
  let recommendation = $state<Recommendation | null>(null);
  let recommendationError = $state<string | null>(null);
  let recommending = $state(false);
  let recommendationRetry = $state(0);
  // The displayed suggestion's complete key, and the position allowed to retain it while loading.
  let recommendationKey: string | null = null;
  let recommendationPosition: string | null = null;
  // The last initialPly seen from the URL, so we react to prop changes only.
  let lastInitialPly: number | null = null;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollGeneration = 0;
  // Set once the component unmounts; async continuations bail out.
  let destroyed = false;
  // Increments per game load; stale continuations compare against it.
  let runId = 0;

  const me = $derived($username);
  const iAmWhite = $derived(game ? isWhiteSide(game, me) : true);
  const totalPlies = $derived(game?.moves.length ?? 0);
  const termination = $derived(game ? pgnTermination(game.pgn) : null);

  // The board shows the position after `currentPly` plies.
  const playedMove = $derived(
    analysis && currentPly > 0 ? (analysis.moves[currentPly - 1] ?? null) : null,
  );
  const nextMove = $derived(
    analysis && currentPly < totalPlies ? (analysis.moves[currentPly] ?? null) : null,
  );

  const currentFen = $derived.by(() => {
    if (!game) return startFen;
    if (currentPly === 0) return game.fens[0] ?? startFen;
    return playedMove?.fenAfter ?? game.fens[currentPly] ?? startFen;
  });

  const lastMoveUci = $derived(
    currentPly === 0
      ? null
      : (playedMove?.uci ?? uciAtPly(game?.moves ?? [], currentPly)),
  );

  const bestMoveUci = $derived(nextMove?.bestMove ?? null);

  const evalCp = $derived(
    playedMove ? playedMove.cpAfter : (analysis?.moves[0]?.cpBefore ?? null),
  );
  const evalMate = $derived(
    playedMove ? playedMove.mateAfter : (analysis?.moves[0]?.mateBefore ?? null),
  );

  // The side to move on the board is the mover of the next move.
  const moverWhite = $derived(currentFen.split(" ")[1] === "w");

  // Player bars: the bottom bar is the side the board is oriented to.
  const topColor = $derived(orientation === "white" ? "black" : "white");
  const bottomColor = $derived(orientation);
  const topPlayer = $derived(
    !game ? null : topColor === "white" ? game.white : game.black,
  );
  const bottomPlayer = $derived(
    !game ? null : bottomColor === "white" ? game.white : game.black,
  );
  const captured = $derived(capturedSummary(game?.moves.slice(0, currentPly) ?? [], game?.fens[0]));

  const mistakePlies = $derived.by(() => {
    if (!analysis) return [] as number[];
    return analysis.moves
      .filter((move) => isNotable(move.classification) && moverIsWhiteAtPly(move.ply) === iAmWhite)
      .map((move) => move.ply);
  });
  const prevMistake = $derived([...mistakePlies].reverse().find((ply) => ply < currentPly) ?? null);
  const nextMistake = $derived(mistakePlies.find((ply) => ply > currentPly) ?? null);

  $effect(() => {
    const name = me;
    const band = tolerance;
    const preference = preferenceOnly;
    const upcoming = analysis?.moves[currentPly];
    const mine = !!upcoming && moverWhite === iAmWhite;
    const position = mine && name ? JSON.stringify([uuid, name, upcoming!.ply]) : null;
    const key = JSON.stringify([uuid, name, upcoming?.ply, band, preference]);
    void recommendationRetry;

    // Keep the same position's suggestion during a parameter refetch only.
    if (recommendationPosition !== position) {
      recommendation = null;
      recommendationError = null;
      recommendationKey = null;
      recommendationPosition = position;
    }
    if (!name || !upcoming || !mine) {
      recommending = false;
      return;
    }

    let stale = false;
    recommending = true;
    void api
      .recommend(name, uuid, upcoming.ply, band, preference)
      .then((result) => {
        if (!stale) {
          recommendation = result;
          recommendationKey = key;
          recommendationError = null;
        }
      })
      .catch((error) => {
        if (!stale) {
          if (recommendationKey !== key) {
            recommendation = null;
            recommendationKey = null;
          }
          recommendationError =
            error instanceof Error ? error.message : "Could not load your suggestion.";
        }
      })
      .finally(() => {
        if (!stale) recommending = false;
      });
    return () => {
      stale = true;
    };
  });

  function autoOrient(): "white" | "black" {
    return iAmWhite ? "white" : "black";
  }

  function isStale(id: string, run: number, name: string, generation?: number): boolean {
    return destroyed || run !== runId || id !== uuid || name !== me ||
      (generation !== undefined && generation !== pollGeneration);
  }

  async function loadGame() {
    const id = uuid;
    const name = me;
    if (!name) return;
    stopPoll();
    const run = ++runId;
    loadError = null;
    analysisStatus = "loading";
    analysisError = null;
    analysisLoadFailed = false;
    analysis = null;
    try {
      const detail = await api.game(id, name);
      if (isStale(id, run, name)) return;
      game = detail;
      currentPly = Math.min(initialPly, detail.moves.length);
      orientation = autoOrient();
      await checkAnalysis(true, id, run, name);
    } catch (err) {
      if (isStale(id, run, name)) return;
      loadError = err instanceof Error ? err.message : "Could not load this game.";
    }
  }

  // Follow later changes of the initialPly prop (address bar, Back/Forward)
  // without fighting the effect that mirrors currentPly into the URL.
  $effect(() => {
    const target = initialPly;
    if (target === lastInitialPly) return;
    lastInitialPly = target;
    if (!game) return;
    const clamped = Math.max(0, Math.min(game.moves.length, target));
    if (clamped !== currentPly) {
      currentPly = clamped;
      hoverUci = null;
    }
  });

  // Mirror the stepper into the URL, replacing the entry so moves do not stack up.
  $effect(() => {
    if (destroyed || !game) return;
    const from = route.from === "style" ? "&from=style" : "";
    navigate(`#/game/${uuid}?ply=${currentPly}${from}`, true);
  });

  async function checkAnalysis(startPolling: boolean, id = uuid, run = runId, name = me) {
    if (!game || !name) return;
    const generation = pollGeneration;
    try {
      const poll = await api.analysis(id, name);
      if (isStale(id, run, name, generation)) return;
      if (poll.status === "done" && poll.analysis) {
        analysis = poll.analysis;
        analysisStatus = "done";
        return;
      }
      if (poll.status === "unanalyzed") {
        analysisStatus = "unanalyzed";
        return;
      }
      analysisStatus = poll.status;
      analysisError = poll.error ?? null;
      if (startPolling && (poll.status === "pending" || poll.status === "running")) {
        startPoll(id, run, name);
      }
    } catch (err) {
      if (isStale(id, run, name, generation)) return;
      // The old server reports "no analysis yet" as a 404.
      if (err instanceof ApiError && err.status === 404) {
        analysisStatus = "unanalyzed";
        return;
      }
      analysisLoadFailed = true;
      analysisStatus = "error";
      analysisError =
        err instanceof Error ? err.message : "Could not load the analysis.";
    }
  }

  function startPoll(id: string, run: number, name: string) {
    stopPoll();
    const generation = pollGeneration;
    async function pollNext() {
      if (isStale(id, run, name, generation)) return;
      try {
        const poll = await api.analysis(id, name);
        if (isStale(id, run, name, generation)) return;
        analysisStatus = poll.status;
        analysisError = poll.error ?? null;
        if (poll.status === "done" && poll.analysis) {
          analysis = poll.analysis;
          stopPoll();
        } else if (poll.status === "error" || poll.status === "unanalyzed") {
          stopPoll();
        }
      } catch {
        if (isStale(id, run, name, generation)) return;
        stopPoll();
        analysisStatus = "error";
        analysisError = "Lost connection while analyzing.";
      }
      if (!isStale(id, run, name, generation)) pollTimer = setTimeout(pollNext, 2000);
    }
    pollTimer = setTimeout(pollNext, 2000);
  }

  function stopPoll() {
    pollGeneration++;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function requestAnalysis() {
    const name = $username;
    if (!name) return;
    const id = uuid;
    const run = runId;
    stopPoll();
    const generation = pollGeneration;
    analysisStatus = "pending";
    analysisError = null;
    analysisLoadFailed = false;
    try {
      await api.analyze(name, [id]);
    } catch (err) {
      if (isStale(id, run, name, generation)) return;
      analysisStatus = "error";
      analysisError = err instanceof Error ? err.message : "Could not queue analysis.";
      return;
    }
    if (isStale(id, run, name, generation)) return;
    startPoll(id, run, name);
  }

  function retryAnalysis() {
    if (analysisLoadFailed) {
      analysisLoadFailed = false;
      analysisStatus = "loading";
      void checkAnalysis(true);
      return;
    }
    void requestAnalysis();
  }

  function goTo(ply: number) {
    currentPly = Math.max(0, Math.min(totalPlies, ply));
    hoverUci = null;
  }

  function onKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    )
      return;
    switch (e.key) {
      case "ArrowLeft":
        goTo(currentPly - 1);
        break;
      case "ArrowRight":
        goTo(currentPly + 1);
        break;
      case "ArrowUp":
        if (prevMistake !== null) goTo(prevMistake);
        break;
      case "ArrowDown":
        if (nextMistake !== null) goTo(nextMistake);
        break;
      case "Home":
        goTo(0);
        break;
      case "End":
        goTo(totalPlies);
        break;
      case "f":
      case "F":
        flip();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function flip() {
    orientation = orientation === "white" ? "black" : "white";
  }

  onMount(() => {
    void loadGame();
    window.addEventListener("keydown", onKeydown);
    return () => {
      destroyed = true;
      window.removeEventListener("keydown", onKeydown);
      stopPoll();
    };
  });
</script>

{#if loadError}
  <div class="mx-auto max-w-2xl px-4 py-10">
    <Notice tone="error" onRetry={loadGame}>{loadError}</Notice>
  </div>
{:else if !game}
  <div class="mx-auto flex max-w-6xl gap-6 px-4 py-8">
    <div class="aspect-square w-full max-w-[640px] animate-pulse rounded-panel bg-surface"></div>
    <div class="hidden flex-1 space-y-3 lg:block">
      {#each Array.from({ length: 6 }) as _, i (i)}
        <div class="h-8 animate-pulse rounded-control bg-surface"></div>
      {/each}
    </div>
  </div>
{:else}
  {@const result = myResult(game, me)}
  <div class="review">
    <div class="board-col">
      {#if topPlayer}
        <PlayerBar
          class="player-bar-top"
          name={topPlayer.username}
          rating={topPlayer.rating}
          color={topColor}
          captured={captured[topColor]}
        />
      {/if}
      <div class="evalbar">
        <EvalBar cp={evalCp} mate={evalMate} pending={!analysis} {orientation} />
      </div>
      <Board
        fen={currentFen}
        {lastMoveUci}
        lastMoveQuality={playedMove?.classification ?? null}
        {bestMoveUci}
        personalMoveUci={recommendation?.forYou?.uci ?? null}
        {hoverUci}
        {orientation}
        label="Chess board, move {currentPly} of {totalPlies}"
      />
      {#if bottomPlayer}
        <PlayerBar
          class="player-bar-bottom"
          name={bottomPlayer.username}
          rating={bottomPlayer.rating}
          color={bottomColor}
          captured={captured[bottomColor]}
        />
      {/if}
    </div>

    <!-- Desktop panel zones: fixed facts and feedback on top (the move
         feedback can never be scrolled away), the move list as the panel's
         only scroller, fixed controls at the bottom (see .panel-feedback and
         .sec-movelist in app.css). -->
    <aside class="panel">
      <PanelHeader {game} {result} {termination} />

      {#if analysisStatus === "loading"}
        <div class="panel-feedback">
          <div class="sec-state space-y-2 p-4" role="status" aria-label="Loading analysis">
            {#each Array.from({ length: 5 }) as _, i (i)}
              <div class="h-6 animate-pulse rounded-control bg-raised"></div>
            {/each}
          </div>
        </div>
      {:else if analysis}
        <div class="sec-accuracy shrink-0 px-4 pt-3">
          <GameSummary summary={analysis.summary} {iAmWhite} />
        </div>

        <div class="sec-graph shrink-0 px-4 pt-3">
          <EvalGraph
            moves={analysis.moves}
            {currentPly}
            {iAmWhite}
            onJump={goTo}
          />
        </div>

        <div class="panel-feedback">
          <div class="sec-played shrink-0 px-4 pt-3">
            {#if playedMove}
              <MovePlayed
                move={playedMove}
                {iAmWhite}
                onShowPosition={() => goTo(currentPly - 1)}
              />
            {:else}
              <section aria-label="Move played" class="py-1">
                <p class="text-[13px] text-muted">Starting position. Step forward to begin the review.</p>
              </section>
            {/if}
          </div>

          <div class="sec-next shrink-0 px-4 pt-3">
            {#if nextMove}
              <NextMove
                move={nextMove}
                {iAmWhite}
                {recommendation}
                {recommending}
                {recommendationError}
                onRetry={() => recommendationRetry++}
                bind:tolerance
                bind:preferenceOnly
                onNext={() => goTo(currentPly + 1)}
              />
            {:else}
              <section aria-label="Next move" class="text-[13px]">
                <p class="font-semibold text-text">Game over.</p>
                {#if termination}<p class="mt-1 text-muted">{termination}</p>{/if}
              </section>
            {/if}
          </div>
        </div>

        <div class="sec-movelist shrink-0 px-2 pt-2" data-movelist-scroll>
          <MoveList
            moves={game.moves}
            analysis={analysis}
            {currentPly}
            {iAmWhite}
            onJump={goTo}
          />
        </div>

        <div class="sec-lines shrink-0 px-3 pb-1 pt-1">
          <EngineLines move={nextMove} onHover={(uci) => (hoverUci = uci)} />
        </div>
      {:else}
        <div class="panel-feedback">
          {#if analysisStatus === "error"}
            <div class="sec-state shrink-0 p-4">
              <Notice tone="error" onRetry={retryAnalysis}>
                {analysisError ?? "Analysis failed."}
              </Notice>
            </div>
          {:else if analysisStatus === "pending" || analysisStatus === "running"}
            <div class="sec-state flex shrink-0 flex-col items-center gap-3 p-8" role="status">
              <Spinner class="size-8 text-muted" />
              <p class="text-[13px] text-muted">
                {analysisStatus === "pending"
                  ? "Queued for analysis…"
                  : "Analyzing. This can take a few minutes."}
              </p>
            </div>
          {:else}
            <div class="sec-state shrink-0 p-6 text-center">
              <p class="text-[16px] font-extrabold text-text">Not analyzed yet</p>
              <p class="mt-1 text-[13px] text-muted">Run the engine to see where this game was decided.</p>
              <Button variant="primary" class="mt-4" onclick={requestAnalysis}>
                Analyze this game
              </Button>
            </div>
          {/if}
        </div>

        <div class="sec-movelist shrink-0 px-2 pt-2" data-movelist-scroll>
          <MoveList
            moves={game.moves}
            analysis={null}
            {currentPly}
            {iAmWhite}
            onJump={goTo}
          />
        </div>
      {/if}

      <PanelControls
        {currentPly}
        {totalPlies}
        hasAnalysis={!!analysis}
        {prevMistake}
        {nextMistake}
        onGoTo={goTo}
        onFlip={flip}
      />
    </aside>
  </div>
{/if}
