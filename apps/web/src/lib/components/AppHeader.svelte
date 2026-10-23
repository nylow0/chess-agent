<!--
  App shell. Below 1024px: a 52px sticky top bar. From 1024px: a fixed 72px
  left rail, black, full height (brand mark on top, nav in the middle,
  username and "Switch player" at the bottom). One <header> element in both
  modes; the brand link comes first and nav keeps aria-label="Main".
-->
<script lang="ts">
  import { route } from "../router.svelte";
  import { username, clearUsername } from "../store";
  import BrandMark from "./BrandMark.svelte";

  const links = [
    { name: "games", label: "Games", href: "#/games" },
    { name: "style", label: "Style", href: "#/style" },
  ] as const;

  // "Games" stays active while a review is open, since it is the list behind it.
  function isActive(name: (typeof links)[number]["name"]): boolean {
    if (name === "games") return route.name === "games" || route.name === "game";
    return route.name === "style";
  }
</script>

<!-- Games icon: a list of games. -->
{#snippet gamesIcon()}
  <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
    <path
      d="M3.5 5h6M3.5 10h6M3.5 15h6"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    <path
      d="M13 4.5l1.2 1.8 2.1.5-1.5 1.6.2 2.2-2-1-2 1 .2-2.2-1.5-1.6 2.1-.5L13 4.5z"
      fill="currentColor"
    />
  </svg>
{/snippet}

<!-- Style icon: sliders, for tuning the player's profile. -->
{#snippet styleIcon()}
  <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
    <path
      d="M5 3v6m0 4v4M10 3v2m0 4v8M15 3v8m0 4v2"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    <circle cx="5" cy="11" r="2" fill="currentColor" />
    <circle cx="10" cy="7" r="2" fill="currentColor" />
    <circle cx="15" cy="13" r="2" fill="currentColor" />
  </svg>
{/snippet}

<header
  class="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-1 bg-bg px-3 lg:fixed lg:inset-y-0 lg:left-0 lg:h-auto lg:w-[72px] lg:flex-col lg:items-stretch lg:gap-0 lg:px-0 lg:py-3"
>
  <!-- Brand mark: a tilted king. The accessible name keeps the non-breaking
       hyphen the wordmark has always used. -->
  <a
    href="#/games"
    aria-label="Post‑mortem"
    class="flex h-9 shrink-0 items-center gap-1.5 rounded-control lg:h-auto lg:justify-center lg:px-0 lg:py-1"
  >
    <BrandMark class="size-6 text-text lg:size-8" />
    <!-- The wordmark shows from 460px up; below that the top bar carries the
         mark alone so "Switch player" never overflows a 360px phone. -->
    <span class="hidden min-[460px]:inline text-[16px] font-extrabold tracking-tight text-text lg:hidden">
      Post&#8209;mortem
    </span>
  </a>

  <nav
    aria-label="Main"
    class="flex items-center gap-1 lg:mt-4 lg:flex-1 lg:flex-col lg:items-center lg:gap-1"
  >
    {#each links as link (link.name)}
      <a
        href={link.href}
        aria-current={isActive(link.name) ? "page" : undefined}
        class="flex h-9 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-semibold transition-colors lg:h-auto lg:w-[60px] lg:flex-col lg:gap-1 lg:px-0 lg:py-2 lg:text-[12px] {isActive(
          link.name,
        )
          ? 'bg-raised text-text'
          : 'text-muted hover:text-text'}"
      >
        {#if link.name === "games"}
          {@render gamesIcon()}
        {:else}
          {@render styleIcon()}
        {/if}
        {link.label}
      </a>
    {/each}
  </nav>

  <!-- Mobile: the username stays hidden and "Switch player" keeps its text,
       which fits at 360px once the wordmark hides below 460px. -->
  <div class="ml-auto flex items-center lg:hidden">
    <button
      type="button"
      onclick={clearUsername}
      class="flex h-8 shrink-0 items-center whitespace-nowrap rounded-control px-2 text-[12px] font-semibold text-muted transition-colors hover:bg-raised hover:text-text"
    >
      Switch player
    </button>
  </div>

  <!-- Desktop rail footer: an avatar circle with the username's first letter,
       the truncated username, and "Switch player" as an icon button. -->
  <div class="hidden w-full flex-col items-center gap-1.5 lg:flex">
    <span
      class="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-[14px] font-extrabold uppercase text-text"
      aria-hidden="true"
    >
      {$username?.charAt(0) ?? ""}
    </span>
    <span
      class="w-full max-w-full truncate text-center text-[12px] text-muted"
      title={$username ?? ""}
      data-testid="header-username"
    >
      {$username}
    </span>
    <!-- Sign out icon: an open door frame with an arrow leaving it -- reads
         as leaving the session, not as the flip control's swap arrows. -->
    <button
      type="button"
      onclick={clearUsername}
      title="Switch player"
      class="flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-text"
    >
      <svg viewBox="0 0 20 20" class="size-5" fill="none" aria-hidden="true">
        <path
          d="M12.5 3.5h-8v13h8M7.5 10h9.5m0 0l-2.75-2.75M17 10l-2.75 2.75"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="sr-only">Switch player</span>
    </button>
  </div>
</header>
