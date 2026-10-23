import { FEATURE_NAMES, type Decision, type FeatureName, type MoveFeatures, type StyleCandidate, type StyleFold } from "@chess/shared";

export const HALF_LIFE_DAYS = 182.625;
const LAMBDAS = [10, 20, 30, 50, 80];
export function vector(value: number): MoveFeatures {
  return Object.fromEntries(FEATURE_NAMES.map(feature => [feature, value])) as MoveFeatures;
}

/** Keep genuine choices near the strongest score. Root ranks can have unequal search depths. */
export function choiceSet(decision: Decision): StyleCandidate[] {
  if (!decision.candidates.length || decision.candidates.some(candidate => candidate.mate !== null)) return [];
  const best = Math.max(...decision.candidates.map(candidate => candidate.value));
  const choices = decision.candidates.filter(candidate => candidate.value >= best - 50);
  return choices.length >= 2 && choices.some(candidate => candidate.uci === decision.played) ? choices : [];
}

export function preferenceFit(candidate: StyleCandidate, weights: MoveFeatures, scales: MoveFeatures): number {
  return FEATURE_NAMES.reduce((sum, feature) => sum + weights[feature] * candidate.features[feature] / scales[feature], 0);
}

export function recencyWeight(playedAt: number, latest: number): number {
  return 2 ** (-Math.max(0, latest - playedAt) / (HALF_LIFE_DAYS * 86400));
}

export function gameFolds(decisions: Decision[]): Map<string, number> {
  return new Map([...new Set(decisions.map(row => row.gameUuid))].sort().map((uuid, i) => [uuid, i % 5]));
}

interface Model { weights: MoveFeatures; scales: MoveFeatures }

/** Precompute standardized choice differences once; fitting never reads held-out rows. */
export function fit(training: Decision[], active: readonly FeatureName[] = FEATURE_NAMES): Model {
  const weights = vector(0);
  const scales = vector(1);
  const latest = Math.max(0, ...training.map(row => row.playedAt));
  const rows = training.map(decision => ({ choices: choiceSet(decision), played: decision.played, weight: recencyWeight(decision.playedAt, latest) }));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  for (const feature of active) {
    let squares = 0, count = 0;
    for (const row of rows) {
      const mean = row.choices.reduce((sum, candidate) => sum + candidate.features[feature], 0) / row.choices.length;
      for (const candidate of row.choices) {
        squares += row.weight * (candidate.features[feature] - mean) ** 2;
        count += row.weight;
      }
    }
    scales[feature] = Math.max(0.25, Math.sqrt(squares / Math.max(1, count)));
  }
  const prepared = rows.map(row => {
    const chosen = row.choices.find(candidate => candidate.uci === row.played)!;
    return {
      weight: row.weight,
      values: row.choices.map(candidate => candidate.value / 50),
      // Centering on the played candidate leaves the softmax unchanged and simplifies its gradient.
      x: row.choices.map(candidate => active.map(feature => (candidate.features[feature] - chosen.features[feature]) / scales[feature])),
      probabilities: new Float64Array(row.choices.length),
    };
  });
  const coefficients = new Float64Array(active.length);
  const gradient = new Float64Array(active.length);
  for (let epoch = 0; epoch < 250 && prepared.length && active.length; epoch++) {
    gradient.fill(0);
    for (const row of prepared) {
      let max = -Infinity;
      for (let i = 0; i < row.x.length; i++) {
        let score = row.values[i];
        for (let f = 0; f < active.length; f++) score += coefficients[f] * row.x[i][f];
        row.probabilities[i] = score;
        max = Math.max(max, score);
      }
      let total = 0;
      for (let i = 0; i < row.x.length; i++) total += row.probabilities[i] = Math.exp(row.probabilities[i] - max);
      for (let i = 0; i < row.x.length; i++) {
        const probability = row.weight * row.probabilities[i] / total;
        for (let f = 0; f < active.length; f++) gradient[f] -= probability * row.x[i][f];
      }
    }
    for (let f = 0; f < active.length; f++) coefficients[f] += 0.08 * (gradient[f] / totalWeight - 0.03 * coefficients[f]);
  }
  active.forEach((feature, i) => { weights[feature] = coefficients[i]; });
  return { weights, scales };
}

function prediction(decision: Decision, model: Model, lambda: number): StyleCandidate {
  const score = (candidate: StyleCandidate) => candidate.value + lambda * preferenceFit(candidate, model.weights, model.scales);
  return choiceSet(decision).reduce((best, candidate) => score(candidate) > score(best) ? candidate : best);
}

/** Exact two-sided binomial sign test. Log probabilities avoid underflow on large samples. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (!n) return 1;
  let logTerm = -n * Math.LN2, logSum = logTerm;
  for (let k = 1; k <= Math.min(wins, losses); k++) {
    logTerm += Math.log(n - k + 1) - Math.log(k);
    const max = Math.max(logSum, logTerm);
    logSum = max + Math.log(Math.exp(logSum - max) + Math.exp(logTerm - max));
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

// Feature selection itself uses pooled inner folds. Outer evaluation never selects features.
export function ablate(training: Decision[]): { selected: FeatureName[]; ablations: { feature: FeatureName; contributionPp: number }[] } {
  const folds = gameFolds(training);
  const partitions = Array.from({ length: 5 }, (_, fold) => ({
    training: training.filter(row => folds.get(row.gameUuid) !== fold),
    testing: training.filter(row => folds.get(row.gameUuid) === fold),
  }));
  const cache = new Map<string, number>();
  const correct = (active: readonly FeatureName[]) => {
    const key = active.join(",");
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let matches = 0;
    for (const partition of partitions) {
      const model = fit(partition.training, active);
      for (const row of partition.testing) {
        if (prediction(row, model, 30).uci === row.played) matches++;
      }
    }
    cache.set(key, matches);
    return matches;
  };
  const choices = training.map(choiceSet);
  // A feature constant across every choice set has exactly zero gradient and contribution.
  let selected = FEATURE_NAMES.filter(feature => choices.some(set => set.some(candidate => candidate.features[feature] !== set[0].features[feature])));
  const contributions = new Map<FeatureName, number>(FEATURE_NAMES.map(feature => [feature, 0]));
  while (selected.length) {
    const baseline = correct(selected);
    const measured = selected.map(feature => ({ feature, contribution: baseline - correct(selected.filter(name => name !== feature)) }));
    for (const row of measured) contributions.set(row.feature, 100 * row.contribution / Math.max(1, training.length));
    const removable = measured.filter(row => row.contribution <= 0).sort((a, b) => a.contribution - b.contribution)[0];
    if (!removable) break;
    // Re-measure after each removal. Jointly dropping individually redundant features can hurt.
    selected = selected.filter(feature => feature !== removable.feature);
  }
  return { selected, ablations: FEATURE_NAMES.map(feature => ({ feature, contributionPp: contributions.get(feature)! })) };
}

function tunedModel(training: Decision[], active: readonly FeatureName[]): Model & { lambda: number } {
  const folds = gameFolds(training);
  const inner = fit(training.filter(row => folds.get(row.gameUuid) !== 0), active);
  const validation = training.filter(row => folds.get(row.gameUuid) === 0);
  let lambda = 30, best = -1;
  for (const value of LAMBDAS) {
    const matches = validation.filter(row => prediction(row, inner, value).uci === row.played).length;
    if (validation.length && matches > best) { best = matches; lambda = value; }
  }
  return { ...fit(training, active), lambda };
}

export function evaluateFold(eligible: Decision[], assignments: Map<string, number>, fold: number, sharpen: boolean): StyleFold {
  const training = eligible.filter(row => assignments.get(row.gameUuid) !== fold);
  const testing = eligible.filter(row => assignments.get(row.gameUuid) === fold);
  const selected = sharpen ? ablate(training).selected : [...FEATURE_NAMES];
  const model = tunedModel(training, selected);
  let modelCorrect = 0, engineCorrect = 0, modelOnly = 0, engineOnly = 0;
  for (const row of testing) {
    const modelRight = prediction(row, model, model.lambda).uci === row.played;
    const engineRight = row.candidates[0].uci === row.played;
    modelCorrect += Number(modelRight); engineCorrect += Number(engineRight);
    modelOnly += Number(modelRight && !engineRight); engineOnly += Number(engineRight && !modelRight);
  }
  return { fold, games: [...assignments.values()].filter(value => value === fold).length,
    decisions: testing.length, modelCorrect, engineCorrect, modelOnly, engineOnly, lambda: model.lambda, selectedFeatures: selected };
}

export function evaluate(eligible: Decision[], assignments: Map<string, number>, sharpen: boolean, onFold?: (fold: StyleFold) => void) {
  const folds = Array.from({ length: 5 }, (_, fold) => {
    const result = evaluateFold(eligible, assignments, fold, sharpen);
    onFold?.(result);
    return result;
  });
  return { folds, ...fitFinal(eligible, sharpen) };
}

export function fitFinal(eligible: Decision[], sharpen: boolean) {
  const selected = sharpen ? ablate(eligible) : { selected: [...FEATURE_NAMES], ablations: [] };
  return { ...selected, model: tunedModel(eligible, selected.selected) };
}
