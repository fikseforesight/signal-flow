// Signal Flow — the critique gauntlet (adversarial demotion). Shared by scan.mjs and retriage.mjs.
//
// Why: the first pass is told to widen, and an AI that widens over-rates its own finds (a manual
// audit of 253 kept items found only 27 genuine firsts/weak signals). Kristen, Oct 26 2026: "take a
// pass at signals 3 times over. Be hypercritical." So every Weak signal / Wild card now has to
// survive THREE independent hostile rounds. Each round sees only the previous round's survivors.
//
//   R1  KNOWN?      Six-test demotion bar. 2+ "yes" = already known → Trend.
//   R2  SUBSTANCE   Is it an actual change in the world (deployment, law, contract, behaviour,
//                   price, failure) — not an opinion, forecast, design concept, lab result or
//                   literature review? Is the source credible? Is the physical-space stake real?
//   R3  VETO        A sceptical senior foresight practitioner + a retail real-estate executive.
//                   Would either already know it, shrug, or call it noise? Does the title overstate?
//
// v4 (Oct 26, Kristen: "only 6 passed from over a month, maybe be a bit more lenient — just acknowledging
// they're H1 or H2"): the gauntlet now GRADES instead of only culling. Known-ness and the practitioner
// read set the Horizon (EDGE keeps H2/H3, EMERGING → H2, ESTABLISHED → H1) and items stay in the queue.
// Only hard fails are demoted: weak/non-credible source, no real physical-space stake, retrospective,
// pure opinion/concept with nothing happening, near-universal knowledge (5-6/6 known), or noise.
// It never deletes. Every verdict and reason is written to Critique.
// Items are numbered 1..n within each chunk and mapped back by position; flat or nested JSON accepted.
const TESTS = ["named", "codified", "counted", "mainstream", "multiple", "practitioners"];

const R1 = `You are round 1 of 3 in an adversarial critique of a strategic-foresight weak-signal library. Default posture: DEMOTION. Be hypercritical.
Weakness = how LITTLE-KNOWN a change is, not how strange it sounds. For each numbered candidate answer six tests from your own knowledge plus the evidence:
named: does the shift already have a coined, widely-used name?
codified: is it backed by law, standard, code, or formal programme in more than one place?
counted: is there survey, market or analyst data quantifying it?
mainstream: has it had mainstream national/international press (not trade press)?
multiple: are there 3+ independent instances?
practitioners: do practitioners already use a trend name for it?
Answer "yes", "no" or "unknown" (unknown is NOT yes). Also "first": yes|plausible|no — credibly a world/national/major-market first?
Return ONLY a JSON array, one object per candidate, same order, same number:
{"n":1,"named":"","codified":"","counted":"","mainstream":"","multiple":"","practitioners":"","first":"","why":"max 25 words"}`;

const R2 = `You are round 2 of 3 in an adversarial critique of a weak-signal library for a foresight lead studying how external forces reshape a mass-market retailer's physical stores and real estate. These candidates survived round 1. Now be hypercritical about SUBSTANCE (not novelty — novelty is graded later). Demote if ANY of these is true:
- not_change: it is an opinion, essay, forecast, design concept, student project, lab/simulation result, literature review, survey of intentions, or product announcement with no real-world deployment — rather than something that has actually started happening (a deployment, law, contract, purchase, behaviour, price, failure, closure, first instance).
- weak_source: the only evidence is a low-credibility venue (preprint server, unindexed or predatory journal, anonymous forum post with no linked evidence, press release), or the summary overstates the source.
- no_stake: the link to physical space (stores, buildings, sites, logistics, real estate, labour in those places) is strained or invented.
- retrospective: it reinterprets the past rather than showing something new.
Note: a credible study, measurement, pilot or proposal tied to a real place counts as something happening — do NOT demote it as not_change. Reserve not_change for pure opinion, concept renders, student projects and speculation.
Return ONLY a JSON array, one object per candidate, same order, same number:
{"n":1,"verdict":"keep|demote","reason":"not_change|weak_source|no_stake|retrospective|ok","why":"max 25 words"}`;

const R3 = `You are round 3 of 3 on a weak-signal library. Two hostile reviewers read each candidate: (a) a sceptical senior strategic-foresight practitioner who has read every trend report, and (b) a retail real-estate executive who runs 1,000+ stores. Be honest and hard-nosed, but GRADE rather than reject: place each item on the Three Horizons.
- "edge": BOTH reviewers would find it genuinely new and unsettling — a true weak signal or wild card (keep its horizon, H2 or H3).
- "emerging": known to specialists or early movers but not yet mainstream practice; a real shift gaining ground (H2).
- "established": both reviewers already know it — part of today's operating picture (H1).
- "noise": a one-off curiosity, PR stunt or non-event with no plausible consequence.
Also flag "overstated": true if the headline claims more than the evidence.
Return ONLY a JSON array, one object per candidate, same order, same number:
{"n":1,"grade":"edge|emerging|established|noise","class":"Weak signal|Wild card","overstated":false,"why":"max 25 words: what the reviewers would say"}`;

async function ask(apiKey, model, sys, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 12000, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`no JSON array (stop_reason=${j.stop_reason})`);
  return JSON.parse(m[0]);
}

// Run one round over items; calls onResult(item, resultObject) for each matched answer.
async function round(items, sys, opts, onResult, label) {
  const size = opts.chunkSize || 20;
  let missing = 0;
  for (let s = 0; s < items.length; s += size) {
    const chunk = items.slice(s, s + size);
    const user = chunk.map((c, k) => `${k + 1}. ${c.title} — shift: ${c.shift || ""} — evidence: ${c.evidence || ""} — source: ${c.source || ""} (${c.date || ""})${c.url ? ` — ${c.url}` : ""}`).join("\n");
    let arr = null;
    for (let attempt = 1; attempt <= 3 && !arr; attempt++) {
      try { arr = await ask(opts.apiKey, opts.model, sys, user); }
      catch (e) { console.error(`  ${label} chunk ${s / size + 1} attempt ${attempt} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 4000 * attempt)); }
    }
    if (!arr) { missing += chunk.length; continue; }
    const done = new Set();
    arr.forEach((r, pos) => {
      const k = Number(r.n ?? r.id ?? r.number) - 1;
      const idx = Number.isInteger(k) && k >= 0 && k < chunk.length && !done.has(k) ? k : pos;
      if (idx >= chunk.length || done.has(idx)) return;
      done.add(idx);
      onResult(chunk[idx], r);
    });
    missing += chunk.length - done.size;
  }
  return missing;
}

function demote(c, cls, note) {
  if (!c.original_classification) c.original_classification = c.classification;
  c.classification = cls;               // Trend / Hype — push-to-notion files these as Demoted
  c.critique_demoted = true;
  c.ai_read = `[${note}] ` + (c.ai_read || "");
}

// The WILD scan is deliberately domain-agnostic, so for it the physical-space stake test is dropped
// and the round-3 reviewers judge novelty for a general foresight practitioner instead.
const wildR2 = (s) => s.replace(/- no_stake:[^\n]*\n/, "");
const wildR3 = (s) => s.replace("and (b) a retail real-estate executive who runs 1,000+ stores", "and (b) a well-read futurist");
export async function critiquePass(cands, opts = {}) {
  const r2 = opts.wild ? wildR2(R2) : R2, r3 = opts.wild ? wildR3(R3) : R3;
  const pool = cands.filter((c) => c.classification === "Weak signal" || c.classification === "Wild card");
  const log = new Map(pool.map((c) => [c, []]));
  const stats = { checked: 0, demoted: 0, missing: 0, r1: 0, r2: 0, r3: 0, survived: 0, edge: 0, emerging: 0, established: 0 };

  // ---- R1: known? ----
  stats.missing += await round(pool, R1, opts, (c, r) => {
    const t = r.tests && typeof r.tests === "object" ? r.tests : r;
    const vals = TESTS.map((x) => String(t[x] ?? "unknown").toLowerCase());
    const yes = vals.filter((v) => v === "yes").length;
    c.weakness = vals.filter((v) => v === "no").length;
    c.first_claim = r.first || c.first_claim;
    c._r1 = true;
    c._known = yes;
    log.get(c).push(`R1 ${yes >= 5 ? "DEMOTE" : "KEEP"} (${yes}/6 known) ${r.why || ""} [${TESTS.map((x, i) => `${x}:${vals[i]}`).join(" ")}]`);
    if (yes >= 5) { demote(c, "Trend", `R1 demoted — widely known (${yes}/6): ${r.why || ""}`); stats.r1++; }
  }, "R1");
  const s1 = pool.filter((c) => c._r1 && !c.critique_demoted);

  // ---- R2: substance, source, stake ----
  stats.missing += await round(s1, r2, opts, (c, r) => {
    c._r2 = true;
    const bad = String(r.verdict).toLowerCase() === "demote";
    log.get(c).push(`R2 ${bad ? "DEMOTE" : "KEEP"} (${r.reason || "?"}) ${r.why || ""}`);
    if (bad) { demote(c, r.reason === "weak_source" || r.reason === "not_change" ? "Hype" : "Trend", `R2 demoted — ${r.reason}: ${r.why || ""}`); stats.r2++; }
  }, "R2");
  const s2 = s1.filter((c) => c._r2 && !c.critique_demoted);

  // ---- R3: practitioner veto ----
  stats.missing += await round(s2, r3, opts, (c, r) => {
    c._r3 = true;
    let grade = String(r.grade || "").toLowerCase();
    if (!["edge", "emerging", "established", "noise"].includes(grade)) grade = "emerging";
    // R1 known-ness caps how "edge" an item can be: 3-4/6 known can't be an edge.
    if (grade === "edge" && c._known >= 3) grade = "emerging";
    if (grade !== "noise" && c._known >= 4) grade = "established";
    c.grade = grade;
    log.get(c).push(`R3 ${grade.toUpperCase()}${r.overstated ? " ⚠ headline overstates evidence" : ""} — ${r.why || ""}`);
    if (grade === "noise") { demote(c, "Hype", `R3 noise: ${r.why || ""}`); stats.r3++; return; }
    if (grade === "edge") { if (r.class === "Weak signal" || r.class === "Wild card") c.classification = r.class; if (!/^H[23]$/.test(c.horizon || "")) c.horizon = "H2"; stats.edge++; }
    else if (grade === "emerging") { c.horizon = "H2"; stats.emerging++; }
    else { c.horizon = "H1"; stats.established++; }
  }, "R3");

  for (const c of pool) {
    const lines = log.get(c);
    if (!lines.length) continue;
    const survived = c._r3 && !c.critique_demoted;
    if (survived) stats.survived++;
    const label = !survived ? "DEMOTED" : c.grade === "edge" ? "EDGE — survived 3/3" : c.grade === "emerging" ? "EMERGING (H2)" : "ESTABLISHED (H1)";
    c.critique = `${label} — ` + lines.join(" | ");
    if (c.critique_demoted) stats.demoted++;
    stats.checked++;
    delete c._r1; delete c._r2; delete c._r3; delete c._known;
  }
  if (stats.missing) console.error(`  critique: ${stats.missing} verdict(s) missing`);
  console.log(`  critique gauntlet: ${pool.length} in → demoted R1 ${stats.r1} / R2 ${stats.r2} / R3 noise ${stats.r3} → kept ${stats.survived}: ${stats.edge} edge, ${stats.emerging} emerging (H2), ${stats.established} established (H1)`);
  return stats;
}
