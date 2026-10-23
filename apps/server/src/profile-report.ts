import { getDecisions, getStyleProfile } from "./style";
const username = process.argv[2];
if (!username) throw new Error("profile-report requires a username");
const profile = getStyleProfile(username);
if (process.argv.includes("--brief")) {
  const { status, decisions, eligibleDecisions, trainingGames, heldOutGames, heldOutDecisions, baselineMatch, modelMatch, lambda, pValue, gainPp, modelOnly, engineOnly } = profile;
  console.log(JSON.stringify({ status, decisions, eligibleDecisions, trainingGames, heldOutGames, heldOutDecisions, baselineMatch, modelMatch, lambda, pValue, gainPp, modelOnly, engineOnly }));
} else {
  console.log(JSON.stringify({ ...profile, traits: profile.traits.map(({ examples, ...trait }) => trait) }, null, 2));
}
const decisions = getDecisions(username);
console.log("clock coverage", decisions.filter(decision => decision.clockLeft !== null).length, "/", decisions.length);
