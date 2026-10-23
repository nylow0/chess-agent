import { getDecisions } from "./style";
import { choiceSet, evaluateFold, fitFinal, gameFolds } from "./model";

const decisions = getDecisions(process.argv[2]);
const eligible = decisions.filter(row => choiceSet(row).length > 0);
const task = process.argv[3];
if (task === "final") console.log(JSON.stringify(fitFinal(eligible, true)));
else {
  const fold = Number(task);
  if (!Number.isInteger(fold) || fold < 0 || fold > 4) throw new Error("Expected a fold from 0 to 4 or final");
  console.log(JSON.stringify(evaluateFold(eligible, gameFolds(decisions), fold, true)));
}
