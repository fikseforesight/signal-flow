// Signal Flow — the critique pass (adversarial demotion gate). Shared by scan.mjs and retriage.mjs.
// Oct 2026: the first pass is told to widen, and an AI that widens also over-rates its own finds —
// in a manual audit of 253 kept items, only 27 survived as genuine firsts/weak signals. So every
// Weak signal / Wild card goes through a second, hostile pass whose only job is to prove the item
// is already known, using Kristen's six-question demotion bar. It can demote (to Trend), never
// promote, never delete.
//
// v2 (Oct 26): items are numbered 1..n WITHIN each chunk and mapped back by position, and both
// nested and flat test layouts are accepted. v1 passed global ids and required a nested "tests"
// object; the model often renumbered or flattened, so most items silently got no critique.
const TESTS = ["named", "codified", "counted", "mainstream", "multiple", "practitioners"];
const SYS = `You are the adversarial critique analyst for a strategic-foresight weak-signal library. Default posture: DEMOTION. For each candidate, actively try to prove it has ALREADY cleared the weak-signal bar — i.e. that it is a known, named, counted thing.

Weakness = how LITTLE-KNOWN a change is, not how strange it sounds. Answer six tests for each, using your own knowledge plus the evidence given:
named: does the shift already have a coined, widely-used name?
codified: is it backed by law, standard, code, or formal programme in more than one place?
counted: is there survey, market or analyst data quantifying it?
mainstream: has it had mainstream national/international press (not trade press) coverage?
multiple: are there multiple independent instances (3+), not one?
practitioners: do practitioners in the field already use a trend name for it?
Answer each "yes", "no" or "unknown". Use "unknown" honestly when you cannot tell (e.g. after your knowledge cutoff) — unknown is NOT yes.

Also judge "first": is this credibly a world/national/major-market FIRST? (yes|plausible|no). Flag "mismatch": true if the title claims more than the evidence supports.
Return ONLY a JSON array with EXACTLY one object per numbered candidate, in the same order, using the SAME number given:
{"n": <the number given>, "named":"yes|no|unknown", "codified":"", "counted":"", "mainstream":"", "multiple":"", "practitioners":"", "first":"yes|plausible|no", "mismatch": false, "why": "max 30 words: strongest reason it is or is not already known"}`;

async function ask(apiKey, model, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 12000, system: SYS, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`no JSON array (stop_reason=${j.stop_reason})`);
  return JSON.parse(m[0]);
}

export async function critiquePass(cands, { apiKey, model, chunkSize = 20 } = {}) {
  const pool = cands.filter((c) => c.classification === "Weak signal" || c.classification === "Wild card");
  let checked = 0, demoted = 0, missing = 0;
  for (let s = 0; s < pool.length; s += chunkSize) {
    const chunk = pool.slice(s, s + chunkSize);
    const user = chunk.map((c, k) => `${k + 1}. ${c.title} — shift: ${c.shift || ""} — evidence: ${c.evidence || ""} — source: ${c.source || ""} (${c.date || ""})`).join("\n");
    let arr = null;
    for (let attempt = 1; attempt <= 3 && !arr; attempt++) {
      try { arr = await ask(apiKey, model, user); }
      catch (e) { console.error(`  critique chunk ${s / chunkSize + 1} attempt ${attempt} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 4000 * attempt)); }
    }
    if (!arr) { missing += chunk.length; continue; }
    arr.forEach((r, pos) => {
      const k = Number(r.n ?? r.id ?? r.number) - 1;
      const c = chunk[Number.isInteger(k) && k >= 0 && k < chunk.length ? k : pos];
      if (!c || c.critique) return;
      const t = r.tests && typeof r.tests === "object" ? r.tests : r;
      const vals = TESTS.map((x) => String(t[x] ?? "unknown").toLowerCase());
      if (vals.every((v) => v === "unknown") && !r.tests && !(TESTS[0] in r)) return; // nothing usable
      const yes = vals.filter((v) => v === "yes").length;
      const unknown = vals.filter((v) => v === "unknown").length;
      c.weakness = vals.filter((v) => v === "no").length; // 6 = no trace of it being known; 0 = established
      c.first_claim = r.first || c.first_claim;
      c.critique = `${yes >= 3 ? "DEMOTE" : "KEEP"} (${yes}/6 known${unknown ? `, ${unknown} unknown` : ""}) — ${r.why || ""} [${TESTS.map((x, i) => `${x}:${vals[i]}`).join(" ")}]${r.mismatch ? " ⚠ title overstates evidence" : ""}`;
      if (yes >= 3) {
        c.original_classification = c.classification;
        c.classification = "Trend";
        c.ai_read = `[Critique demoted: ${r.why || "already known"}] ` + (c.ai_read || "");
        demoted++;
      }
      checked++;
    });
    missing += chunk.filter((c) => !c.critique).length;
  }
  if (missing) console.error(`  critique: ${missing} item(s) got no usable verdict`);
  return { checked, demoted, missing };
}
