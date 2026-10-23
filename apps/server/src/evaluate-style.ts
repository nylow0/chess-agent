import type { StyleFold } from "@chess/shared";
import { assembleProfile, getDecisions, profileSignature, saveProfile, selectValidatedProfile, trainProfile } from "./style";
import type { fitFinal } from "./model";

// Run after the queue finishes. Expensive nested ablation stays outside API requests.
const username = process.argv[2];
if (!username) throw new Error("evaluate-style requires a username");
const signature = profileSignature(username);
console.log("dataset signature", signature);
const decisions = getDecisions(username);
const started = performance.now();
const baseline = trainProfile(username, decisions);
console.log("phase C", JSON.stringify({ status: baseline.status, gainPp: baseline.gainPp, pValue: baseline.pValue }));
if (JSON.stringify(trainProfile(username, decisions)) !== JSON.stringify(baseline)) throw new Error("Repeated five-fold evaluation changed on identical data.");
console.log("phase C repeat matched exactly");
console.log("phase D: starting nested feature elimination");
const resumeIndex = process.argv.indexOf("--resume");
const folds: StyleFold[] = [];
if (resumeIndex !== -1) {
  // Resume only a log from the same immutable dataset and implementation.
  const lines = (await Bun.file(process.argv[resumeIndex + 1]).text()).split(/\r?\n/);
  if (!lines.includes(`dataset signature ${signature}`)) throw new Error("Checkpoint belongs to a different dataset or model version.");
  for (const line of lines.filter(line => line.startsWith("completed outer fold "))) {
    const fold = JSON.parse(line.slice("completed outer fold ".length)) as StyleFold;
    if (!folds.some(existing => existing.fold === fold.fold)) folds.push(fold);
  }
  console.log("reused outer folds", folds.map(fold => fold.fold));
  for (const fold of folds) console.log("completed outer fold", JSON.stringify(fold));
}
let finalModel: ReturnType<typeof fitFinal> | undefined;
const tasks = ["final", ...Array.from({ length: 5 }, (_, fold) => String(fold)).filter(fold => !folds.some(result => result.fold === Number(fold)))];
const running = new Set<ReturnType<typeof Bun.spawn>>();
// Bound CPU parallelism to four processes. Each task only reads the saved decisions.
try {
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (tasks.length) {
      const task = tasks.shift()!;
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/model-task.ts`, username, task], { stdout: "pipe", stderr: "pipe" });
      running.add(child);
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      running.delete(child);
      if (code !== 0) throw new Error(`Model task ${task} failed: ${errors}`);
      if (task === "final") {
        finalModel = JSON.parse(output) as ReturnType<typeof fitFinal>;
        console.log("final model fit complete");
      } else {
        const fold = JSON.parse(output) as StyleFold;
        folds.push(fold);
        console.log("completed outer fold", JSON.stringify(fold));
      }
    }
  }));
} finally {
  for (const child of running) child.kill();
}
if (!finalModel || folds.length !== 5) throw new Error("Incomplete feature evaluation");
folds.sort((a, b) => a.fold - b.fold);
const candidate = assembleProfile(username, decisions, { folds, ...finalModel });
const profile = selectValidatedProfile(baseline, candidate);
if (profileSignature(username) !== signature) throw new Error("Analyses changed during evaluation. Rerun after the queue finishes.");
saveProfile(profile, signature);
console.log(JSON.stringify({ ...profile, weights: undefined, scales: undefined, traits: undefined, seconds: (performance.now() - started) / 1000 }, null, 2));
