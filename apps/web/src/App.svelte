<script lang="ts">
  import { route, navigate } from "./lib/router.svelte";
  import { username } from "./lib/store";
  import AppHeader from "./lib/components/AppHeader.svelte";
  import LoginView from "./lib/views/LoginView.svelte";
  import DashboardView from "./lib/views/DashboardView.svelte";
  import GameView from "./lib/views/GameView.svelte";
  import StyleView from "./lib/views/StyleView.svelte";

  // The stored username decides the gate immediately; no network wait on boot.
  function handleLogin() {
    navigate("#/games");
  }

  // The review screen owns exactly the viewport height on desktop, so the
  // board can be as large as the viewport allows without a page scroll.
  const gameActive = $derived(route.name === "game");

  $effect(() => {
    const screen =
      $username === null
        ? "Sign in"
        : route.name === "style"
          ? "Style"
          : route.name === "game"
            ? "Review"
            : "Games";
    document.title = `${screen} · Chess Agent`;
  });
</script>

{#if $username === null}
  <LoginView onLogin={handleLogin} />
{:else}
  <div class="min-h-dvh lg:pl-[72px] {gameActive ? 'lg:h-dvh lg:overflow-hidden' : ''}">
    <AppHeader />
    {#if route.name === "games"}
      <DashboardView />
    {:else if route.name === "style"}
      <StyleView />
    {:else if route.name === "game" && route.uuid}
      {#key route.uuid}
        <GameView uuid={route.uuid} initialPly={route.ply} />
      {/key}
    {/if}
  </div>
{/if}
