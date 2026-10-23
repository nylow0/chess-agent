<script lang="ts">
  import { onMount } from "svelte";
  import type { StyleProfile } from "@shared";
  import { api } from "../api";
  import { username } from "../store";
  import Notice from "../components/ui/Notice.svelte";
  import Button from "../components/ui/Button.svelte";
  import Spinner from "../components/ui/Spinner.svelte";
  import GainMeter from "../components/style/GainMeter.svelte";
  import TraitRow from "../components/style/TraitRow.svelte";
  import { traitCopy } from "../components/style/traitCopy";

  let profile = $state<StyleProfile | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    const name = $username;
    if (!name || loading) return;
    loading = true;
    try {
      profile = await api.style(name);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not load your style.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Poll only while the server retrains in the background, then stop.
  $effect(() => {
    if (!profile?.updating) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  });

  const verdict = $derived.by(() => {
    const p = profile;
    if (!p) return null;
    if (!p.enoughData) {
      return {
        pill: "Not enough games",
        pillClass: "bg-raised text-muted",
        headline: "There are not enough analyzed games yet.",
        text: "Analyze more games. The check needs at least 10 analyzed games and a few hundred positions where several moves were about equally good.",
      };
    }
    if (p.status === "confirmed") {
      return {
        pill: "Confirmed",
        pillClass: "bg-win/15 text-win",
        headline: "Your choices are predictable enough to personalise suggestions.",
        text: "Game reviews now show a suggestion that fits your style next to the engine's choice.",
      };
    }
    if (p.status === "weak_signal") {
      return {
        pill: "Weak signal",
        pillClass: "bg-cls-inaccuracy/15 text-cls-inaccuracy",
        headline: "There is a pattern in your choices, but it is not strong enough yet.",
        text: "Personal suggestions stay off until both checks pass. More analyzed games can change this.",
      };
    }
    return {
      pill: "No signal",
      pillClass: "bg-raised text-muted",
      headline: "No reliable pattern yet.",
      text: "Among near-equal moves, your choices are not easier to predict than the engine's top move. Personal suggestions stay off.",
    };
  });

  const gainPass = $derived((profile?.gainPp ?? 0) >= 2);
  const pPass = $derived((profile?.pValue ?? 1) < 0.05);

  const tendencyTraits = $derived(
    (profile?.traits ?? [])
      .filter((trait) => Math.abs(trait.preference) >= 0.08)
      .sort((a, b) => Math.abs(b.preference) - Math.abs(a.preference)),
  );
  const maxPreference = $derived(
    tendencyTraits.reduce((max, trait) => Math.max(max, Math.abs(trait.preference)), 0),
  );

  // Keep only measured performance traits, carrying the number so it needs no assertion.
  const performanceTraits = $derived(
    (profile?.traits ?? [])
      .flatMap((trait) => (trait.performanceCp === null ? [] : [{ trait, cp: trait.performanceCp }]))
      .sort((a, b) => Math.abs(b.cp) - Math.abs(a.cp)),
  );

  function points(value: number): string {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function pLabel(value: number): string {
    return value < 0.001 ? "p < 0.001" : `p = ${value.toFixed(3)}`;
  }

  function rate(value: number | null): string {
    return value === null ? "not measured" : `${(value * 100).toFixed(1)}%`;
  }

  function formatNumber(value: number): string {
    return value.toLocaleString("en-US");
  }
</script>

<main class="px-4 py-8 sm:px-6 lg:px-10">
  <header>
    <h1 class="text-[28px] font-extrabold tracking-tight text-text">Your style</h1>
    <p class="mt-1 text-sm text-muted">What you tend to choose when the engine sees several moves as about equally good.</p>
  </header>

  {#if error}
    <div class="mt-6"><Notice tone="error" onRetry={load}>{error}</Notice></div>
  {:else if !profile}
    <p class="mt-6 flex items-center gap-2 text-muted" role="status"><Spinner /> Reading your analyzed games…</p>
  {:else}
    {#if profile.updating}
      <div class="mt-6"><Notice tone="info">Updating with your newest games. This takes about half a minute.</Notice></div>
    {/if}

    {#if profile.decisions === 0}
      <section class="mt-6 rounded-panel bg-surface p-6">
        {#if profile.updating}
          <p class="text-text">Building your style profile. This takes about half a minute.</p>
        {:else}
          <p class="text-base text-text">Analyze some games first. Your style is learned from analyzed games.</p>
          <Button href="#/games" class="mt-4">Go to your games</Button>
        {/if}
      </section>
    {:else}
      {#if verdict}
        <section class="mt-8 rounded-panel bg-surface p-6" aria-label="Style verdict">
          <div class="grid gap-6 lg:grid-cols-2 lg:gap-10">
            <div>
              <span class="inline-flex h-6 items-center rounded-control px-2.5 text-[13px] font-semibold {verdict.pillClass}">{verdict.pill}</span>
              <h2 class="mt-4 text-[20px] font-extrabold tracking-tight leading-snug text-text">{verdict.headline}</h2>
              <p class="mt-2 max-w-xl text-sm text-muted">{verdict.text}</p>
            </div>

            {#snippet mark(pass: boolean)}
              {#if pass}
                <svg class="size-6 shrink-0 text-win" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span class="sr-only">Passed</span>
              {:else}
                <svg class="size-6 shrink-0 text-loss" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span class="sr-only">Not passed</span>
              {/if}
            {/snippet}

            {#if profile.enoughData}
              <div>
                <ul class="space-y-4">
                  <li class="flex items-center justify-between gap-4 text-sm">
                    <span class="flex items-center gap-2.5">
                      {@render mark(gainPass)}
                      <span>Better than the engine's top move by at least 2 points</span>
                    </span>
                    <span class="whitespace-nowrap tabular-nums text-text" data-testid="gain-value">{points(profile.gainPp)} points</span>
                  </li>
                  <li class="flex items-center justify-between gap-4 text-sm">
                    <span class="flex items-center gap-2.5">
                      {@render mark(pPass)}
                      <span>Unlikely to be chance (p below 0.05)</span>
                    </span>
                    <span class="whitespace-nowrap tabular-nums text-text">{pLabel(profile.pValue)}</span>
                  </li>
                </ul>
                <div class="mt-6">
                  <GainMeter gainPp={profile.gainPp} />
                </div>
              </div>
            {/if}
          </div>

          {#if profile.enoughData}
            <div class="mt-8">
              <p class="max-w-2xl text-[13px] text-muted">
                The engine's top move matched your move {rate(profile.baselineMatch)} of the time. The style model matched {rate(profile.modelMatch)}.
              </p>
              <p class="mt-1 max-w-2xl text-[13px] text-muted">
                Measured on {formatNumber(profile.heldOutDecisions)} near-equal choices from {formatNumber(profile.trainingGames)} games. Every game was used once for testing.
              </p>
            </div>
          {/if}
        </section>
      {/if}

      <section class="mt-14" aria-label="Your tendencies">
        <h2 class="text-[20px] font-extrabold tracking-tight text-text">Your tendencies</h2>
        <p class="mt-2 max-w-2xl text-sm text-muted">
          {profile.status === "confirmed"
            ? "The leanings the style model uses for your suggestions."
            : "These are leanings in your past choices. They are not yet reliable enough to drive suggestions."}
        </p>
        {#if tendencyTraits.length === 0}
          <p class="mt-4 text-muted">No clear leanings yet.</p>
        {:else}
          <div class="mt-8 space-y-5">
            {#each tendencyTraits as trait (trait.feature)}
              <TraitRow {trait} maxPreference={maxPreference} />
            {/each}
          </div>
        {/if}
      </section>

      {#if performanceTraits.length > 0}
        <section class="mt-14" aria-label="Where you play better or worse">
          <h2 class="text-[20px] font-extrabold tracking-tight text-text">Where you play better or worse</h2>
          <p class="mt-1 max-w-2xl text-sm text-muted">How your next ten moves went after choosing a move of this kind, compared with similar positions. These are observations, not proof of cause.</p>
          <ul class="mt-4 max-w-2xl space-y-3">
            {#each performanceTraits as { trait, cp } (trait.feature)}
              <li class="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span class="font-bold text-text">{traitCopy[trait.feature].positive.name}</span>
                <span class={cp >= 0 ? "text-win" : "text-loss"}>
                  about {(Math.abs(cp) / 100).toFixed(1)} pawns {cp >= 0 ? "less" : "more"} lost
                </span>
                <span class="text-[13px] text-muted">from {formatNumber(trait.samples)} positions</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <details class="group mt-14">
        <summary class="flex min-h-8 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-text">
          How this is measured
          <svg
            viewBox="0 0 16 16"
            class="size-3.5 text-muted transition-transform group-open:rotate-180"
            fill="none"
            aria-hidden="true"
          >
            <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </summary>
        <div class="mt-4 max-w-2xl space-y-3 text-[13px] text-muted">
          <p>The model is tested with five-fold cross-validation: the games are split into five groups, and each group is predicted by a model trained on the other four. Recent games count more (half-life: six months).</p>
          <p class="tabular-nums">Counted positions: {formatNumber(profile.heldOutDecisions)} near-equal choices out of {formatNumber(profile.decisions)} decisions.</p>
          <p class="tabular-nums">
            Only the model was right in {formatNumber(profile.modelOnly)} positions; only the engine's top move was right in {formatNumber(profile.engineOnly)}. The p-value is an exact two-sided sign test on those {formatNumber(profile.modelOnly + profile.engineOnly)} positions.
          </p>
        </div>
        <div class="mt-5 max-w-xl">
          <table class="w-full text-left text-[13px] tabular-nums" aria-label="Validation folds">
            <thead>
              <tr class="border-b border-line text-xs font-semibold text-muted">
                <th class="py-2">Fold</th>
                <th class="py-2 text-right">Games</th>
                <th class="py-2 text-right">Choices</th>
                <th class="py-2 text-right">Model</th>
                <th class="py-2 text-right">Engine</th>
              </tr>
            </thead>
            <tbody>
              {#each profile.folds as fold}
                <tr class="h-9">
                  <td>{fold.fold + 1}</td>
                  <td class="text-right">{fold.games}</td>
                  <td class="text-right">{fold.decisions}</td>
                  <td class="text-right">{fold.decisions ? `${((fold.modelCorrect / fold.decisions) * 100).toFixed(1)}%` : "—"}</td>
                  <td class="text-right">{fold.decisions ? `${((fold.engineCorrect / fold.decisions) * 100).toFixed(1)}%` : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if profile.ablations.length > 0}
          <h3 class="mt-8 text-[16px] font-extrabold tracking-tight text-text">Feature experiment</h3>
          {#if profile.featureSelection}
            <p class="mt-3 text-sm text-text">Feature elimination: {((profile.featureSelection.originalMatch ?? 0) * 100).toFixed(2)}% to {((profile.featureSelection.candidateMatch ?? 0) * 100).toFixed(2)}% held-out match rate. {profile.featureSelection.adopted ? "Pruned model adopted." : "Original model retained because pruning did not improve the validated result."}</p>
          {/if}
          <p class="mt-3 max-w-2xl text-[13px] text-muted">In this experiment, features are removed one at a time only when pooled inner validation does not get worse. Retained features are measured against the experiment's final set; removed features show their last measured contribution. Its outer-fold test repeats selection inside each training fold.</p>
          <div class="mt-3 grid gap-2 text-[13px] text-muted sm:grid-cols-2">
            {#each profile.ablations as row}
              <p>{traitCopy[row.feature].positive.name}: {points(row.contributionPp)} points, {(profile.featureSelection?.selectedFeatures ?? profile.selectedFeatures).includes(row.feature) ? "retained in experiment" : "removed in experiment"}</p>
            {/each}
          </div>
        {/if}
      </details>
    {/if}
  {/if}
</main>
