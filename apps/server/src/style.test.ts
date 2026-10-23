import { expect, test } from "bun:test";
import { FEATURE_NAMES, type Decision, type MoveFeatures, type StyleCandidate } from "@chess/shared";
import { assembleProfile, choiceSet, performanceEffect, recommend, selectValidatedProfile, trainProfile } from "./style";
import { ablate, evaluateFold, fit, fitFinal, gameFolds, HALF_LIFE_DAYS, recencyWeight, signTest } from "./model";

const zero = Object.fromEntries(FEATURE_NAMES.map(feature => [feature, 0])) as MoveFeatures;
function candidate(uci: string, value: number, trades: number): StyleCandidate {
  return { uci, san: uci, cp: value, mate: null, pv: [uci], value, features: { ...zero, trades } };
}
function data(): Decision[] {
  return Array.from({ length: 20 }, (_, game) => Array.from({ length: 20 }, (_, ply): Decision => ({
    gameUuid: String(game).padStart(2, "0"), playedAt: 1700000000 + game * 86400, ply: ply * 2 + 1, fen: "", played: "d2d4",
    candidates: [candidate("e2e4", 25, 0), candidate("d2d4", 10, 1), candidate("a2a3", -100, 2)],
    clockLeft: null, timeSpent: null, phase: "opening", nextTenPlyCpl: 15,
  }))).flat();
}

test("learns a preference across whole held-out games and keeps unsafe moves out", () => {
  const rows = data();
  const profile = trainProfile("me", rows);
  expect(profile.trainingGames).toBe(20);
  expect(profile.heldOutGames).toBe(20);
  expect(profile.heldOutDecisions).toBe(400);
  expect(profile.folds.map(fold => fold.decisions)).toEqual([80, 80, 80, 80, 80]);
  expect(profile.baselineMatch).toBe(0);
  expect(profile.modelMatch).toBe(1);
  expect(profile.status).toBe("confirmed");
  expect(profile.weights).toEqual(fit(rows).weights);
  expect(profile.pValue).toBeLessThan(0.05);
  for (const tolerance of [0, 10, 30, 100]) {
    const result = recommend(rows[0], profile, tolerance, true);
    expect(result.forYou).not.toBeNull();
    expect(result.forYou!.value).toBeGreaterThanOrEqual(25 - tolerance);
  }
  expect(recommend(rows[0], profile, 30, true).forYou?.uci).toBe("d2d4");
});

test("held-out choices cannot select features or tune their own fold", () => {
  const rows = data();
  const assignments = gameFolds(rows);
  const before = evaluateFold(rows, assignments, 0, true);
  for (const row of rows) if (Number(row.gameUuid) % 5 === 0) { row.played = "e2e4"; row.nextTenPlyCpl = 999; }
  const after = evaluateFold(rows, assignments, 0, true);
  expect(after.selectedFeatures).toEqual(before.selectedFeatures);
  expect(after.lambda).toBe(before.lambda);
  expect(before.modelCorrect).toBe(80);
  expect(after.modelCorrect).toBe(0);
}, 30000);

test("the gate baseline is rank one even when score rank disagrees", () => {
  const rows = data().map(row => ({ ...row, candidates: [candidate("e2e4", 0, 0), candidate("d2d4", 10, 1)] }));
  const profile = trainProfile("me", rows);
  expect(profile.baselineMatch).toBe(0);
  expect(profile.modelMatch).toBe(1);
  expect(profile.gainPp).toBe(100);
  expect(profile.pValue).toBeCloseTo(signTest(400, 0), 130);
  expect(profile.status).toBe("confirmed");
  const outsideBand = { ...rows[0], candidates: [candidate("e2e4", -100, 0), candidate("d2d4", 10, 1), candidate("g1f3", 0, 0)] };
  expect(choiceSet(outsideBand).map(line => line.uci)).toEqual(["d2d4", "g1f3"]);
  const fold = evaluateFold([outsideBand], gameFolds([outsideBand]), 0, false);
  expect(fold.engineCorrect).toBe(0);
});

test("no profile from too little data or blunders, and mate never gets traded for style", () => {
  const rows = data();
  expect(trainProfile("me", rows.slice(0, 20)).enoughData).toBe(false);
  expect(choiceSet({ ...rows[0], played: "a2a3" })).toHaveLength(0);
  const profile = trainProfile("me", rows);
  rows[0].candidates[0].mate = 3;
  expect(choiceSet(rows[0])).toHaveLength(0);
  expect(recommend(rows[0], profile).forYou?.uci).toBe("e2e4");
});

test("sign test handles ties, exact small samples and large disagreement counts", () => {
  expect(signTest(0, 0)).toBe(1);
  expect(signTest(5, 5)).toBe(1);
  expect(signTest(10, 0)).toBeCloseTo(2 / 1024, 12);
  expect(signTest(117, 95)).toBeGreaterThan(0.1);
  expect(signTest(117, 95)).toBeLessThan(0.2);
  expect(signTest(2000, 2000)).toBeCloseTo(1, 8);
});

test("recency weights halve in six months and never upweight a future timestamp", () => {
  expect(recencyWeight(0, HALF_LIFE_DAYS * 86400)).toBeCloseTo(0.5);
  expect(recencyWeight(10, 0)).toBe(1);
});

test("ablation retains useful choice features and drops constant context", () => {
  const result = ablate(data());
  expect(result.selected).toEqual(["trades"]);
  expect(result.ablations.find(row => row.feature === "trades")!.contributionPp).toBeGreaterThan(0);
  expect(result.ablations.find(row => row.feature === "complexity")!.contributionPp).toBe(0);
});

test("independently computed folds assemble the same profile as serial evaluation", () => {
  const rows = data();
  const assignments = gameFolds(rows);
  const folds = [4, 2, 0, 3, 1].map(fold => evaluateFold(rows, assignments, fold, true)).sort((a, b) => a.fold - b.fold);
  const assembled = assembleProfile("me", rows, { folds, ...fitFinal(rows, true) });
  expect(assembled).toEqual(trainProfile("me", rows, true));
}, 30000);

test("feature elimination cannot replace a stronger confirmed profile", () => {
  const original = trainProfile("me", data());
  const weaker = { ...original, modelMatch: 0.9, weights: { ...original.weights, trades: 0 } };
  expect(selectValidatedProfile(original, weaker).weights).toEqual(original.weights);
  expect(selectValidatedProfile(original, weaker).featureSelection?.adopted).toBe(false);
  expect(selectValidatedProfile(original, { ...original, status: "weak_signal" }).featureSelection?.adopted).toBe(false);
  expect(selectValidatedProfile(original, original).featureSelection?.adopted).toBe(true);
});

test("phase and score confounding cannot become a performance claim", () => {
  const rows = data();
  rows.forEach((row, i) => {
    row.played = i % 2 ? "d2d4" : "e2e4";
    row.phase = i % 2 ? "opening" : "endgame";
    row.nextTenPlyCpl = i % 2 ? 10 : 100;
  });
  expect(performanceEffect(rows, "trades").effect).toBeNull();
  rows.forEach(row => { row.phase = "middlegame"; });
  expect(performanceEffect(rows, "trades").effect).toBeCloseTo(90);
  rows.forEach((row, i) => { for (const move of row.candidates) move.value += i % 2 ? 300 : -300; });
  expect(performanceEffect(rows, "trades").effect).toBeNull();
});

test("unconfirmed profiles disable recommendations, and defaults are preference-only", () => {
  const rows = data();
  const profile = trainProfile("me", rows);
  expect(recommend(rows[0], profile)).toEqual(recommend(rows[0], profile, 30, true));
  expect(recommend(rows[0], { ...profile, status: "weak_signal" }).forYou).toBeNull();
  expect(recommend(rows[0], { ...profile, status: "no_signal" }).forYou).toBeNull();
});

test("tolerance uses the mover's score when Black's good moves have negative White scores", () => {
  const rows = data();
  const profile = trainProfile("me", rows);
  const decision = rows[0];
  for (const move of decision.candidates) move.cp = -move.value;
  const result = recommend(decision, profile, 0);
  expect(result.forYou?.uci).toBe("e2e4");
  expect(result.forYou?.cp).toBe(-25);
  expect(result.reason).toContain("engine's choice");
});

test("zero tolerance excludes the first engine line when another root line scores higher", () => {
  const rows = data();
  const profile = trainProfile("me", rows);
  rows[0].candidates[0].value = -124;
  rows[0].candidates[1].value = -118;
  rows[0].candidates[2].value = -129;
  expect(recommend(rows[0], profile, 0).forYou?.value).toBe(-118);
});
