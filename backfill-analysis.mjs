// Signal Flow — one-time backfill: attempts Horizon, Novelty, Impact Scale, Disruptive
// Potential, and Initial Analysis for every EXISTING Notion signal that's missing them.
// Methodology: IFTF's "signals of change" interpretation framework (what kind of change,
// from what to what; what's driving it; what the world looks like if it spreads) plus the
// novelty/impact/disruptive-potential dimensions used in the UNEP/ISC weak-signals study.
// Never overwrites a field that already has a value — human edits AND prior AI reads are
// both left untouched. Safe to re-run any time; only ever fills blanks.
// Manually triggered (Actions tab -> "Backfill signal analysis" -> Run workflow).
// Secrets: NOTION_TOKEN, NOTION_DATABASE_ID, ANTHROPIC_API_KEY. Native Node 20+, no deps.

const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_DATABASE_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_VERSION = "2022-06-28";
const MODEL = "claude-sonnet-5";
const BATCH_SIZE = 12; // signals per Claude call

if (!TOKEN || !DB || !API_KEY) {
  console.error("Missing NOTION_TOKEN, NOTION_DATABASE_ID, or ANTHROPIC_API_KEY. Add all three as repo secrets.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HORIZON_VALID = new Set(["H1", "H2", "H3"]);
const NOVELTY_VALID = new Set(["High", "Medium", "Low"]);
const IMPACT_VALID = new Set(["Local", "Regional", "Global"]);
const DISRUPTIVE_VALID = new Set(["Minor", "Major", "Catastrophic"]);

async function notion(path, method, body) {
  const res = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { await sleep(1500); return notion(path, method, body); } // rate-limit backoff
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// property readers
const readRt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join("").trim();
const readSel = (prop) => prop?.select?.name || "";
const readTitle = (prop) => (prop?.title || []).map((t) => t.plain_text).join("").trim();
const readMulti = (prop) => (prop?.multi_select || []).map((o) => o.name).join(", ");
// Notion rich_text caps each text object at 2000 chars
const rt = (s) => (s == null ? [] : [{ type: "text", text: { content: String(s).slice(0, 1990) } }]);

async function fetchAllPages() {
  const pages = [];
  let cursor;
  do {
    const j = await notion(`/databases/${DB}/query`, "POST", cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    pages.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : undefined;
    if (cursor) await sleep(350);
  } while (cursor);
  return pages;
}

function summarize(page) {
  const p = page.properties;
  return {
    id: page.id,
    signal: readTitle(p["Signal"]) || "(untitled)",
    whatsChanging: readRt(p["What's changing"]),
    aiRead: readRt(p["AI Read"]),
    evidence: readRt(p["Evidence"]),
    classification: readSel(p["Classification"]),
    steep: readMulti(p["STEEP-V Origin"]),
    maturity: readSel(p["Maturity"]),
    needHorizon: !readSel(p["Horizon"]),
    needNovelty: !readSel(p["Novelty"]),
    needImpact: !readSel(p["Impact Scale"]),
    needDisruptive: !readSel(p["Disruptive Potential"]),
    needAnalysis: !readRt(p["Initial Analysis"]),
  };
}
async function callClaude(batch) {
  const sys = `You are doing a retroactive analysis pass for Signal Flow, a strategic-foresight weak-signal database. Kristen holds all qualification judgment; you attempt tentative, honestly-labeled suggestions only for fields that are currently blank — never claim certainty, never override her judgment.

For each signal below, using the IFTF "signals of change" interpretation framework (what kind of change is this an example of, from what to what; what's driving or motivating it; what the world would look like if it became common/widespread) and standard weak-signal methodology (novelty, impact scale, disruptive potential — distinct from likelihood/credibility, which already exist), return:
- horizon: "H1" (0-3yr) | "H2" (3-10yr) | "H3" (10-30yr) — bias to H3 for weak/civilizational signals unless there's a concrete near-term trigger
- novelty: "High" | "Medium" | "Low" — how unprecedented or unfamiliar this shift is
- impact_scale: "Local" | "Regional" | "Global" — how far the impact would spread if it materializes
- disruptive_potential: "Minor" | "Major" | "Catastrophic" — magnitude of disruption if it plays out
- initial_analysis: 2-3 sentences, tentative — what kind of change this is an example of (from what to what), what's driving it, and what the world would look like if it became common

Return ONLY a JSON array matching input order, one object per signal, ALL 5 fields always present regardless of whether that particular signal needs every one (the caller only applies fields that are currently blank). No prose, no markdown fences.`;

  const user = batch.map((s, n) =>
    `${n + 1}. SIGNAL: ${s.signal}\nWHAT'S CHANGING: ${s.whatsChanging || "(none)"}\nAI READ: ${s.aiRead || "(none)"}\nEVIDENCE: ${s.evidence || "(none)"}\nCLASSIFICATION: ${s.classification || "(none)"}\nSTEEP: ${s.steep || "(none)"}\nMATURITY: ${s.maturity || "(none)"}`
  ).join("\n---\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("No JSON array in model response");
  return JSON.parse(m[0]);
}

function buildPatch(s, r) {
  const p = {};
  if (s.needHorizon && HORIZON_VALID.has(r.horizon)) p["Horizon"] = { select: { name: r.horizon } };
  if (s.needNovelty && NOVELTY_VALID.has(r.novelty)) p["Novelty"] = { select: { name: r.novelty } };
  if (s.needImpact && IMPACT_VALID.has(r.impact_scale)) p["Impact Scale"] = { select: { name: r.impact_scale } };
  if (s.needDisruptive && DISRUPTIVE_VALID.has(r.disruptive_potential)) p["Disruptive Potential"] = { select: { name: r.disruptive_potential } };
  if (s.needAnalysis && r.initial_analysis) p["Initial Analysis"] = { rich_text: rt(r.initial_analysis) };
  return p;
}

async function run() {
  console.log("Fetching all signals from Notion…");
  const pages = await fetchAllPages();
  console.log(`${pages.length} total signals in the database.`);

  const todo = pages
    .map(summarize)
    .filter((s) => s.needHorizon || s.needNovelty || s.needImpact || s.needDisruptive || s.needAnalysis);
  console.log(`${todo.length} need enrichment, ${pages.length - todo.length} already complete on all 5 fields.`);

  let enriched = 0, emptyPatch = 0, failed = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(todo.length / BATCH_SIZE)}: analyzing ${batch.length} signals…`);
    let results;
    try {
      results = await callClaude(batch);
    } catch (e) {
      console.error(`  ! batch failed, skipping: ${e.message}`);
      failed += batch.length;
      continue;
    }
    for (let n = 0; n < batch.length; n++) {
      const s = batch[n];
      const r = results[n];
      if (!r) { failed++; console.error(`  ! no result for "${s.signal.slice(0, 60)}"`); continue; }
      const patch = buildPatch(s, r);
      if (!Object.keys(patch).length) { emptyPatch++; continue; }
      try {
        await notion(`/pages/${s.id}`, "PATCH", { properties: patch });
        enriched++;
        await sleep(350); // stay under ~3 req/s
      } catch (e) {
        failed++;
        console.error(`  ! ${s.signal.slice(0, 60)}: ${e.message}`);
      }
    }
    await sleep(500);
  }

  console.log(`\nBackfill complete: ${enriched} signals enriched, ${emptyPatch} skipped (model returned nothing usable), ${failed} failed.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
