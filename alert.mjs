// Signal Flow — post-scan review queue + alerts.
// Runs right after each scan (daily and wild). Two jobs:
//  1. Writes a review queue to the Actions run summary (Actions tab → the run → Summary),
//     strongest survivors first, so review starts the moment the scan lands.
//  2. Opens a GitHub issue (GitHub emails you) when (a) the AI pass failed or only partly ran,
//     or (b) the scan surfaced strong candidates: credible FIRSTS, wild cards, or items the
//     critique pass rated 5-6/6 unknown.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (both provided by Actions), OUTPUT_FILE.
// No dependencies. Never touches Notion.
import { readFileSync, existsSync, appendFileSync } from "node:fs";

const OUT = process.env.OUTPUT_FILE || "candidates.json";
const status = existsSync("scan-status.json") ? JSON.parse(readFileSync("scan-status.json", "utf8")) : { ai: "unknown" };
const cands = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")).candidates || []) : [];
const feed = status.feed || "scan";

const survivors = cands.filter((c) => c.classification === "Weak signal" || c.classification === "Wild card");
const score = (c) => (c.first_claim === "yes" ? 3 : c.first_claim === "plausible" ? 1.5 : 0) + (c.classification === "Wild card" ? 1.5 : 0) + (Number.isFinite(c.weakness) ? c.weakness / 2 : 0) + (c.novelty === "High" ? 1 : 0);
survivors.sort((a, b) => score(b) - score(a));
const strong = survivors.filter((c) => c.first_claim === "yes" || c.classification === "Wild card" || (Number.isFinite(c.weakness) && c.weakness >= 5));

const line = (c) => `- **${c.title}** — ${c.classification}${c.horizon ? ` · ${c.horizon}` : ""}${c.domain_branch ? ` · ${c.domain_branch}` : ""}${c.geography ? ` · ${c.geography}` : ""}${c.first_claim === "yes" ? " · **FIRST?**" : ""}${Number.isFinite(c.weakness) ? ` · weakness ${c.weakness}/6` : ""}\n  ${c.shift || ""}\n  ${c.critique ? `_Critique:_ ${c.critique.slice(0, 260)}\n  ` : ""}[${c.source || "source"}](${c.url})`;

const demoted = status.critique ? status.critique.demoted : 0;
let summary = `## Signal Flow ${feed} scan — ${status.date || ""}\n\n`;
summary += `Raw ${status.raw ?? "?"} → unseen ${status.unseen ?? "?"} → sent to AI ${status.sent ?? "?"} → candidates ${cands.length}. AI pass: **${status.ai}**${status.error ? ` (${status.error})` : ""}. Critique: ${status.critique ? `${status.critique.checked} checked, ${demoted} demoted` : "not run"}.\n\n`;
summary += `### Review queue (${survivors.length} survivors, strongest first)\n\n${survivors.slice(0, 25).map(line).join("\n") || "_none_"}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

async function issue(title, body, labels) {
  const { GITHUB_TOKEN: t, GITHUB_REPOSITORY: repo } = process.env;
  if (!t || !repo) { console.log("(no GITHUB_TOKEN — skipping issue)"); return; }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ title, body: body.slice(0, 60000), labels }),
  });
  console.log(`issue "${title}": ${res.status}`);
}

if (status.ai === "failed" || status.ai === "no-key") {
  await issue(`⚠ Signal Flow ${feed} scan: AI triage failed (${status.date})`,
    `The ${feed} scan ran but the AI pass **did not**. ${cands.length} raw, untriaged items were saved so nothing is lost.\n\nError: \`${status.error}\`\n\nIf the error mentions credit balance or billing, top up at console.anthropic.com → Billing. Then re-run the scan from the Actions tab.`, ["scan-failure"]);
} else if (status.ai === "partial") {
  await issue(`Signal Flow ${feed} scan: ${status.failedBatches} AI batch(es) failed (${status.date})`, summary, ["scan-failure"]);
}
if (strong.length) {
  await issue(`Signal Flow: ${strong.length} strong candidate${strong.length > 1 ? "s" : ""} from the ${feed} scan (${status.date})`,
    `Firsts, wild cards and items the critique pass could not find any trace of. These are AI-suggested and unqualified — your call.\n\n${strong.map(line).join("\n")}\n\n---\n${summary}`, ["signal-alert"]);
}
