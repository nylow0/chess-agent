import { Chess } from "chess.js";
import { FEATURE_NAMES, type GameAnalysis } from "@chess/shared";
import { db } from "./db";
import { choiceSet, getDecisions, getStyleProfile, recommend } from "./style";

const username = process.argv[2];
if (!username) throw new Error("audit-data requires a username");
const rows = db.query<{ uuid: string; pgn: string; data: string }, []>(`SELECT g.uuid, g.pgn, a.data
  FROM games g JOIN analyses a ON a.game_uuid = g.uuid WHERE a.status = 'done'`).all();
const totalGames = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM games").get()!.n;
if (rows.length !== totalGames && !process.argv.includes("--partial")) throw new Error(`Backfill is incomplete: ${rows.length}/${totalGames}`);
let mateGames = 0;
let checkedCandidates = 0;
let personalMoves = 0;
let checkedRecommendations = 0;
for (const row of rows) {
  const chess = new Chess();
  chess.loadPgn(row.pgn);
  const analysis = JSON.parse(row.data) as GameAnalysis;
  if (analysis.engine.depth !== Number(process.env.ANALYSIS_DEPTH ?? 14) || analysis.engine.multiPv !== 6) {
    throw new Error(`Unexpected engine settings: ${row.uuid}`);
  }
  if (analysis.moves.length !== chess.history().length) throw new Error(`Incomplete analysis: ${row.uuid}`);
  if (!Number.isFinite(analysis.summary.myAccuracy) || analysis.summary.myAccuracy < 0 || analysis.summary.myAccuracy > 100) throw new Error(`Invalid accuracy: ${row.uuid}`);
  for (const move of analysis.moves) {
    const sign = move.fenBefore.split(" ")[1] === "w" ? 1 : -1;
    const ceiling = move.lines[5];
    for (const fallback of move.lines.slice(6)) {
      if (ceiling?.cp !== null && ceiling?.cp !== undefined && fallback.cp !== null && fallback.cp * sign > ceiling.cp * sign) throw new Error(`Inflated fallback: ${row.uuid}:${move.ply}`);
    }
  }
  if (chess.isCheckmate()) {
    mateGames++;
    const final = analysis.moves.at(-1)!;
    if (final.mateAfter !== 0 || Math.sign(final.cpAfter!) !== (chess.turn() === "w" ? -1 : 1)) {
      throw new Error(`Incorrect mate winner: ${row.uuid}`);
    }
  }
}
const profile = getStyleProfile(username);
const decisions = getDecisions(username);
for (const trait of profile.traits) {
  for (const example of trait.examples) {
    const decision = decisions.find(decision => decision.gameUuid === example.gameUuid && decision.ply === example.ply + 1);
    const chosen = decision?.candidates.find(candidate => candidate.uci === decision.played);
    if (!chosen || chosen.san !== example.san) throw new Error("Trait example does not match its actual position");
    const choices = choiceSet(decision!);
    const mean = choices.reduce((sum, candidate) => sum + candidate.features[trait.feature], 0) / choices.length;
    if (trait.preference * (chosen.features[trait.feature] - mean) <= 0) throw new Error("Trait example contradicts its tendency");
  }
  if (trait.performanceCp !== null && !trait.performanceFolds.every(effect => effect !== null && Math.sign(effect) === Math.sign(trait.performanceCp!))) throw new Error("Unstable performance claim");
}
for (const decision of decisions) {
  if (!decision.candidates.length) continue;
  if (!decision.playedAt) throw new Error("Missing historical date");
  for (const fallback of decision.candidates.slice(6)) {
    if (fallback.value > decision.candidates[5].value || fallback.value > decision.candidates[0].value) throw new Error(`Fallback outranks root candidates: ${decision.gameUuid}:${decision.ply} values=${decision.candidates.map(candidate => candidate.value).join(",")}`);
  }
  if (!decision.candidates.some(candidate => candidate.uci === decision.played)) {
    throw new Error(`Missing played move: ${decision.gameUuid}:${decision.ply}`);
  }
  for (const candidate of decision.candidates) {
    const chess = new Chess(decision.fen);
    chess.move({ from: candidate.uci.slice(0, 2), to: candidate.uci.slice(2, 4), promotion: candidate.uci[4] });
    if (!FEATURE_NAMES.every(feature => Number.isFinite(candidate.features[feature]))) throw new Error("Non-finite features");
    checkedCandidates++;
  }
  for (const tolerance of [0, 30, 100]) {
    if (recommend(decision, profile, tolerance).forYou) personalMoves++;
    // Exercise candidate safety even when the real profile is gated off.
    for (const preferenceOnly of [true, false]) {
      const result = recommend(decision, { ...profile, status: "confirmed" }, tolerance, preferenceOnly);
      if (!result.forYou) throw new Error("Missing hypothetical recommendation");
      if (decision.candidates.every(candidate => candidate.mate === null)) {
        const best = Math.max(...decision.candidates.map(candidate => candidate.value));
        if (result.forYou.value < best - tolerance) throw new Error(`Recommendation exceeded its tolerance: ${decision.gameUuid}:${decision.ply} band=${tolerance} selected=${result.forYou.value} values=${decision.candidates.map(candidate => candidate.value).join(",")}`);
      }
      checkedRecommendations++;
    }
  }
}
console.log(JSON.stringify({ totalGames, analyzedGames: rows.length, mateGames, decisions: decisions.length, checkedCandidates, checkedRecommendations, personalMoves,
  clockCoverage: decisions.filter(decision => decision.clockLeft !== null).length,
  profile: { status: profile.status, trainingGames: profile.trainingGames, heldOutGames: profile.heldOutGames,
    heldOutDecisions: profile.heldOutDecisions, modelMatch: profile.modelMatch, baselineMatch: profile.baselineMatch },
  results: db.query("SELECT white_result, black_result, COUNT(*) n FROM games GROUP BY white_result, black_result").all(),
}));
