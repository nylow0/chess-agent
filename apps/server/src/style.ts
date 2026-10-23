import { FEATURE_NAMES, type Decision, type FeatureName, type MoveFeatures, type Recommendation, type StyleFold, type StyleProfile, type StyleTrait } from "@chess/shared";
import path from "node:path";
import { db, dbPath } from "./db";
import { choiceSet, evaluate, gameFolds, HALF_LIFE_DAYS, preferenceFit, recencyWeight, signTest } from "./model";
export { choiceSet, preferenceFit } from "./model";

/** Compare only like phases and pre-move evaluation buckets, with support on both sides. */
export function performanceEffect(decisions: Decision[], feature: FeatureName): { effect: number | null; samples: number } {
  const strata = new Map<string, { high: { loss: number; weight: number }[]; low: { loss: number; weight: number }[] }>();
  const latest = Math.max(0, ...decisions.map(row => row.playedAt));
  for (const row of decisions) {
    const chosen = row.candidates.find(candidate => candidate.uci === row.played);
    if (!chosen || row.nextTenPlyCpl === null || row.candidates.some(candidate => candidate.mate !== null)) continue;
    const value = row.candidates[0].value;
    const bucket = value < -150 ? "losing" : value > 150 ? "winning" : "balanced";
    const key = `${row.phase}:${bucket}`;
    const stratum = strata.get(key) ?? { high: [], low: [] };
    stratum[chosen.features[feature] > 0 ? "high" : "low"].push({ loss: row.nextTenPlyCpl, weight: recencyWeight(row.playedAt, latest) });
    strata.set(key, stratum);
  }
  let effect = 0, support = 0, samples = 0;
  for (const { high, low } of strata.values()) {
    if (high.length < 10 || low.length < 10) continue;
    const mean = (rows: typeof high) => rows.reduce((sum, row) => sum + row.loss * row.weight, 0) / rows.reduce((sum, row) => sum + row.weight, 0);
    const weight = Math.min(high.reduce((sum, row) => sum + row.weight, 0), low.reduce((sum, row) => sum + row.weight, 0));
    effect += weight * (mean(low) - mean(high));
    support += weight;
    samples += high.length + low.length;
  }
  return { effect: support ? effect / support : null, samples };
}

function performanceTraits(decisions: Decision[], weights: MoveFeatures, ablations: StyleProfile["ablations"]): StyleTrait[] {
  const assignments = gameFolds(decisions);
  return FEATURE_NAMES.map(feature => {
    const pooled = performanceEffect(decisions, feature);
    // Test the sign in disjoint held-out folds, not overlapping training subsets.
    const performanceFolds = Array.from({ length: 5 }, (_, fold) => performanceEffect(decisions.filter(row => assignments.get(row.gameUuid) === fold), feature).effect);
    const stable = pooled.effect !== null && pooled.effect !== 0 && performanceFolds.every(effect => effect !== null && Math.sign(effect) === Math.sign(pooled.effect!));
    const examples = decisions.flatMap(decision => {
      const choices = choiceSet(decision);
      const chosen = choices.find(candidate => candidate.uci === decision.played);
      if (!chosen) return [];
      const mean = choices.reduce((sum, candidate) => sum + candidate.features[feature], 0) / choices.length;
      const strength = weights[feature] * (chosen.features[feature] - mean);
      return strength > 0 ? [{ decision, chosen, strength }] : [];
    }).sort((a, b) => b.strength - a.strength || a.decision.gameUuid.localeCompare(b.decision.gameUuid) || a.decision.ply - b.decision.ply);
    return { feature, preference: weights[feature], performanceCp: stable ? pooled.effect : null,
      performanceFolds, contributionPp: ablations.find(row => row.feature === feature)?.contributionPp ?? 0,
      samples: pooled.samples, examples: examples.slice(0, 3).map(({ decision, chosen }) => ({ gameUuid: decision.gameUuid, ply: decision.ply - 1, san: chosen.san })),
    };
  });
}

export function trainProfile(username: string, decisions: Decision[], sharpen = false, onFold?: (fold: StyleFold) => void): StyleProfile {
  const assignments = gameFolds(decisions);
  const eligible = decisions.filter(row => choiceSet(row).length > 0);
  return assembleProfile(username, decisions, evaluate(eligible, assignments, sharpen, onFold));
}

/** Assemble the same profile whether the independent outer folds run serially or in workers. */
export function assembleProfile(username: string, decisions: Decision[], result: ReturnType<typeof evaluate>): StyleProfile {
  const assignments = gameFolds(decisions);
  const eligible = decisions.filter(row => choiceSet(row).length > 0);
  const modelOnly = result.folds.reduce((sum, fold) => sum + fold.modelOnly, 0);
  const engineOnly = result.folds.reduce((sum, fold) => sum + fold.engineOnly, 0);
  const modelMatch = eligible.length ? result.folds.reduce((sum, fold) => sum + fold.modelCorrect, 0) / eligible.length : null;
  const baselineMatch = eligible.length ? result.folds.reduce((sum, fold) => sum + fold.engineCorrect, 0) / eligible.length : null;
  const gainPp = eligible.length ? 100 * (modelOnly - engineOnly) / eligible.length : 0;
  const pValue = signTest(modelOnly, engineOnly);
  const enoughData = assignments.size >= 10 && result.folds.every(fold => fold.decisions >= 20 && eligible.length - fold.decisions >= 50);
  return {
    username, status: !enoughData || gainPp <= 0 ? "no_signal" : pValue < 0.05 && gainPp >= 2 ? "confirmed" : "weak_signal",
    enoughData, pValue, gainPp, modelOnly, engineOnly, folds: result.folds,
    selectedFeatures: result.selected, ablations: result.ablations, recencyHalfLifeDays: HALF_LIFE_DAYS,
    decisions: decisions.length, eligibleDecisions: eligible.length,
    trainingGames: assignments.size, heldOutGames: assignments.size, heldOutDecisions: eligible.length,
    baselineMatch, modelMatch, ...result.model,
    traits: performanceTraits(decisions, result.model.weights, result.ablations),
  };
}

export function getDecisions(username: string): Decision[] {
  const rows = db.query<{ data: string }, [string]>(`SELECT d.data FROM decisions d
    JOIN analyses a ON a.game_uuid = d.game_uuid WHERE d.username = ? COLLATE NOCASE AND a.status = 'done'
    ORDER BY d.game_uuid, d.ply`).all(username);
  return rows.map(row => JSON.parse(row.data) as Decision);
}

/** A feature experiment cannot replace a better validated model or lose its confirmation. */
export function selectValidatedProfile(original: StyleProfile, candidate: StyleProfile): StyleProfile {
  const adopted = candidate.modelMatch !== null && original.modelMatch !== null && candidate.modelMatch >= original.modelMatch &&
    (original.status !== "confirmed" || candidate.status === "confirmed");
  const selected = adopted ? candidate : original;
  return { ...selected, ablations: candidate.ablations,
    traits: selected.traits.map(trait => ({ ...trait,
      contributionPp: candidate.ablations.find(row => row.feature === trait.feature)?.contributionPp ?? 0,
    })),
    featureSelection: { adopted, originalMatch: original.modelMatch, candidateMatch: candidate.modelMatch,
      candidateGainPp: candidate.gainPp, candidatePValue: candidate.pValue, selectedFeatures: candidate.selectedFeatures },
  };
}

db.run("CREATE TABLE IF NOT EXISTS style_profiles (username TEXT PRIMARY KEY COLLATE NOCASE, signature TEXT NOT NULL, data TEXT NOT NULL)");
export function profileSignature(username: string): string {
  // v6: the evaluation baseline is engine rank one, not the maximum candidate score.
  return "v6:" + JSON.stringify(db.query(`SELECT COUNT(*) n, MAX(a.updated_at) updated FROM decisions d
    JOIN analyses a ON a.game_uuid = d.game_uuid WHERE d.username = ? COLLATE NOCASE AND a.status = 'done'`).get(username));
}

export function saveProfile(profile: StyleProfile, signature: string): void {
  db.run("INSERT INTO style_profiles VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET signature = excluded.signature, data = excluded.data",
    [profile.username, signature, JSON.stringify(profile)]);
}

export function getStyleProfile(username: string): StyleProfile {
  const key = username.toLowerCase();
  const signature = profileSignature(key);
  const cached = db.query<{ signature: string; data: string }, [string]>("SELECT signature, data FROM style_profiles WHERE username = ?").get(key);
  if (cached?.signature === signature) return JSON.parse(cached.data) as StyleProfile;
  const profile = trainProfile(key, getDecisions(key));
  saveProfile(profile, signature);
  return profile;
}

/** The stored profile row, stale or not, or null when nothing is saved. */
export function storedProfile(username: string): StyleProfile | null {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM style_profiles WHERE username = ?").get(username.toLowerCase());
  return row ? JSON.parse(row.data) as StyleProfile : null;
}

/** Load a single decision without parsing every decision the player owns. */
export function getDecision(username: string, gameUuid: string, ply: number): Decision | null {
  const row = db.query<{ data: string }, [string, string, number]>(
    `SELECT d.data FROM decisions d JOIN analyses a ON a.game_uuid = d.game_uuid
     WHERE d.username = ? COLLATE NOCASE AND d.game_uuid = ? AND d.ply = ? AND a.status = 'done'`
  ).get(username, gameUuid, ply);
  return row ? JSON.parse(row.data) as Decision : null;
}

function hasDecisions(username: string): boolean {
  const row = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) n FROM decisions d JOIN analyses a ON a.game_uuid = d.game_uuid
     WHERE d.username = ? COLLATE NOCASE AND a.status = 'done'`
  ).get(username);
  return (row?.n ?? 0) > 0;
}

type ProfileSpawner = (username: string) => void;

const trainingInFlight = new Set<string>();
const trainingChildren = new Set<Bun.Subprocess>();

/** Release every child; only successful runs may retry a result discarded as stale. */
export function makeTrainSpawner(spawn: (username: string) => Bun.Subprocess, onExit?: (username: string) => void): ProfileSpawner {
  return (username) => {
    try {
      const child = spawn(username);
      trainingChildren.add(child);
      void child.exited.then((code) => {
        trainingChildren.delete(child);
        trainingInFlight.delete(username);
        if (code === 0) onExit?.(username);
        else console.error(`style training failed for ${username}: exit code ${code}`);
      }).catch(() => {
        /* a failed exit wait must also release tracking */
        trainingChildren.delete(child);
        trainingInFlight.delete(username);
      });
    } catch (err) {
      trainingInFlight.delete(username);
      console.error(`style training failed to start for ${username}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/**
 * Command and environment for the background trainer. The child inherits the
 * parent's environment but not variables assigned at runtime, so CHESS_DB_PATH
 * is passed explicitly to keep the trainer on the database this process opened.
 */
export function trainerLaunch(username: string): { cmd: string[]; env: Record<string, string | undefined> } {
  return {
    cmd: [process.execPath, path.join(import.meta.dir, "train-profile.ts"), username],
    env: { ...process.env, CHESS_DB_PATH: dbPath },
  };
}

/** Retrain in a child process so an HTTP request never blocks on the statistical model. */
const spawnTrainProfile = makeTrainSpawner((username) => {
  const { cmd, env } = trainerLaunch(username);
  return Bun.spawn(cmd, { env, stdout: "inherit", stderr: "inherit" });
}, retrainIfStale);

/** True when the stored profile does not match the analysed decisions. */
function profileStale(username: string): boolean {
  const stored = db.query<{ signature: string }, [string]>("SELECT signature FROM style_profiles WHERE username = ?").get(username);
  return stored ? stored.signature !== profileSignature(username) : hasDecisions(username);
}

/**
 * A trainer that ran while games were being analysed discards its result, which
 * would leave the profile stale with nothing scheduled. Retrain once after it
 * exits successfully, but only when this player's queue is idle so we cannot busy-loop
 * against active analysis.
 */
function retrainIfStale(username: string): void {
  if (db.query("SELECT 1 FROM analyses WHERE username = ? COLLATE NOCASE AND status IN ('pending', 'running') LIMIT 1").get(username)) return;
  if (profileStale(username)) scheduleStyleTraining(username);
}

/** Start at most one background retrain per username; safe to call from request and queue paths. */
export function scheduleStyleTraining(username: string, spawner: ProfileSpawner = spawnTrainProfile): void {
  const key = username.toLowerCase();
  // A child cannot share an in-memory database, so only the real spawner skips here.
  if (spawner === spawnTrainProfile && dbPath === ":memory:") return;
  if (trainingInFlight.has(key)) return;
  trainingInFlight.add(key);
  try {
    spawner(key);
  } catch (err) {
    trainingInFlight.delete(key);
    console.error(`style training failed to start for ${key}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Resolve once every trainer spawned so far has exited; used by the real-process test. */
export function trainingIdle(): Promise<void> {
  return Promise.all([...trainingChildren].map((child) => child.exited.then(() => undefined).catch(() => undefined))).then(() => undefined);
}

/** Kill any in-flight background trainers, used on server shutdown. */
export function killTraining(): void {
  for (const child of trainingChildren) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  trainingChildren.clear();
}

/**
 * Return the stored profile immediately and flag whether a background retrain is
 * needed. At most one training child runs per username, injected in tests.
 */
export function readStyleProfile(
  username: string,
  spawner: ProfileSpawner = spawnTrainProfile
): { profile: StyleProfile; updating: boolean } {
  const key = username.toLowerCase();
  const stored = db.query<{ signature: string; data: string }, [string]>(
    "SELECT signature, data FROM style_profiles WHERE username = ?"
  ).get(key);
  const updating = stored ? stored.signature !== profileSignature(key) : hasDecisions(key);
  if (updating) scheduleStyleTraining(key, spawner);
  return { profile: stored ? JSON.parse(stored.data) as StyleProfile : trainProfile(key, []), updating };
}

export function recommend(decision: Decision, profile: StyleProfile, tolerance = 30, preferenceOnly = true): Recommendation {
  const band = Math.max(0, Math.min(100, tolerance));
  const engineBest = decision.candidates[0] ?? null;
  const unavailable = (reason: string): Recommendation => ({ engineBest, forYou: null, reason, tolerance: band });
  if (!engineBest) return unavailable("No candidate moves for this position.");
  if (profile.status !== "confirmed") return unavailable("Style suggestions are off because your style signal is not confirmed yet.");
  if (decision.candidates.some(candidate => candidate.mate !== null)) {
    return { engineBest, forYou: engineBest, reason: "A forced mate comes before style.", tolerance: band };
  }
  const bestValue = Math.max(...decision.candidates.map(candidate => candidate.value));
  const candidates = decision.candidates.filter(candidate => candidate.value >= bestValue - band);
  const performanceFit = (candidate: Decision["candidates"][number]) => profile.traits.reduce((sum, trait) => sum +
    (trait.performanceCp !== null && candidate.features[trait.feature] > 0 ? Math.max(-2, Math.min(2, trait.performanceCp / 30)) : 0), 0);
  const score = (candidate: Decision["candidates"][number]) => candidate.value + profile.lambda * (
    (preferenceOnly ? 1 : 0.35) * preferenceFit(candidate, profile.weights, profile.scales) +
    (preferenceOnly ? 0 : 0.65) * performanceFit(candidate));
  const selected = candidates.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best);
  const labels: Record<FeatureName, string> = {
    trades: "exchanges", queensOff: "queenless positions", centerLock: "locked centers", openFiles: "open files",
    aggression: "forcing moves", pawnStorm: "pawn advances toward the king", kingSafety: "king safety", materialRisk: "material sacrifices",
    activity: "piece activity", restriction: "restricting replies", complexity: "uneven candidate scores", endgame: "endgames",
    development: "developing pieces", centerControl: "central control",
  };
  const contributions = FEATURE_NAMES.map(feature => ({ feature,
    difference: selected.features[feature] - engineBest.features[feature],
    contribution: profile.weights[feature] * (selected.features[feature] - engineBest.features[feature]) / profile.scales[feature],
  })).filter(row => row.contribution > 0.01).sort((a, b) => b.contribution - a.contribution).slice(0, 2);
  const reason = contributions.map(row => `${row.difference > 0 ? "More" : "Less"} ${labels[row.feature]} fits your past choices`).join("; ");
  return { engineBest, forYou: selected, tolerance: band,
    reason: selected.uci === engineBest.uci ? "The engine's choice is also the best fit for your style." :
      preferenceOnly ? reason || "This is the best fit for your past choices among moves of similar strength." : "Experimental: also weighs the kinds of position you tend to play well.",
  };
}
