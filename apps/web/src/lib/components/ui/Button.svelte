<!--
  Action control. Renders an <a> when `href` is set, otherwise a <button>.
  variant: primary (solid white, one per screen) | secondary (raised fill) | ghost (text only).
  size controls padding/type size; `loading` shows a spinner and disables the control.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Spinner from "./Spinner.svelte";

  let {
    variant = "secondary",
    size = "md",
    loading = false,
    disabled = false,
    type = "button",
    onclick,
    href,
    class: className = "",
    children,
  }: {
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    onclick?: (event: MouseEvent) => void;
    href?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  const base =
    "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text disabled:cursor-not-allowed disabled:opacity-40";

  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2.5 text-sm",
  } as const;

  const variants = {
    primary: "bg-text text-bg hover:bg-white",
    secondary: "bg-raised text-text hover:bg-line",
    ghost: "text-muted hover:text-text",
  } as const;

  const classes = $derived(`${base} ${sizes[size]} ${variants[variant]} ${className}`);
</script>

{#if href}
  <a {href} class={classes} onclick={onclick}>
    {#if loading}<Spinner class="size-4" />{/if}
    {@render children?.()}
  </a>
{:else}
  <button {type} disabled={disabled || loading} class={classes} onclick={onclick}>
    {#if loading}<Spinner class="size-4" />{/if}
    {@render children?.()}
  </button>
{/if}
