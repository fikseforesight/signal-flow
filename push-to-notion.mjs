// Signal Flow — push triaged weak-signal candidates from the repo into Notion.
// Runs in GitHub Actions. Reads candidates.json / substack-candidates.json / wild-candidates.json,
// and UPSERTS each signal into the Notion library, keyed on a stable Signal ID so re-runs
// never duplicate. Existing pages are left untouched (your human edits are safe).
// Secrets: NOTION_TOKEN, NOTION_DATABASE_ID. Native Node 20+, no dependencies.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN || !DB) {
  console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID. Add both as repo secrets.");
  process.exit(1);
}

// which candidate files to sync, and the "Scan Feed" label each maps to
const FILES = [
  ["candidates.json", "daily"],
  ["substack-candidates.json", "substack"],
  ["wild-candidates.json", "wild"],
];

if (existsSync("archive")) { for (const f of readdirSync("archive")) { if (/^candidates-\d{4}-\d{2}-\d{2}\.json$/.test(f)) FILES.push([`archive/${f}`, "daily"]); else if (/^wild-\d{4}-\d{2}-\d{2}\.json$/.test(f)) FILES.push([`archive/${f}`, "wild"]); else if (/^substack-\d{4}-\d{2}-\d{2}\.json$/.test(f)) FILES.push([`archive/${f}`, "substack"]); } }

const STEEP_VALID = new Set(["Social", "Technological", "Economic", "Environmental", "Political", "Demographic", "Values"]);
const CLASS_VALID = new Set(["Weak signal", "Wild card", "Trend", "Megatrend", "Hype"]);
const SWIPES_VALID = new Set(["Statistics", "Writings", "Innovations", "Pitches", "Entrants & exits", "Superhits & outliers"]);
const HORIZON_VALID = new Set(["H1", "H2", "H3"]);
const MATURITY_VALID = new Set(["Signal", "Early indicator", "Trigger"]);
const DIGIT_VALID = new Set(["0", "1", "2", "3", "4", "5"]);
// Source Type is a free-growing select (Notion auto-creates new option names on first use),
// so no fixed set here — any non-empty string the pipeline attaches is passed through as-is.

function normUrl(u) {
  if (!u) return "";
  try { const x = new URL(u.trim()); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); }
  catch { return (u || "").trim().toLowerCase(); }
}
function signalId(c) {
  return createHash("sha1").update(normUrl(c.url || c.link || "") + "|" + (c.title || "")).digest("hex");
}
// Notion rich_text caps each text object at 2000 chars
const rt = (s) => (s == null ? [] : [{ type: "text", text: { content: String(s).slice(0, 1990) } }]);
const asArray = (v) => (Array.isArray(v) ? v : (typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()) : []));

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

async function exists(sid) {
  const j = await notion(`/databases/${DB}/query`, "POST", {
    filter: { property: "Signal ID", rich_text: { equals: sid } }, page_size: 1,
  });
  return (j.results || []).length > 0;
}

function buildProps(c, feed) {
  const origins = [...new Set([c.steep, c.steep2].filter((s) => STEEP_VALID.has(s)))].map((n) => ({ name: n }));
  const themes = asArray(c.themes).slice(0, 25).map((n) => ({ name: String(n).slice(0, 90) }));
  const keywords = asArray(c.keywords).slice(0, 25).map((n) => ({ name: String(n).slice(0, 90) }));
  const isRuleout = c.classification === "Trend" || c.classification === "Hype";
  const p = {
    "Signal": { title: rt(c.title || "(untitled)") },
    "Signal ID": { rich_text: rt(signalId(c)) },
    "What's changing": { rich_text: rt(c.shift || c.whats_changing || "") },
    "AI Read": { rich_text: rt(c.ai_read || c.aiRead || "") },
    "Evidence": { rich_text: rt(c.evidence || "") },
    "Source": { rich_text: rt(c.source || "") },
    "Scan Feed": { select: { name: feed } },
    "Status": { select: { name: isRuleout ? "Demoted" : "Pending" } },
    "Provenance": { select: { name: "AI-suggested" } },
  };
  if (c.url && /^https?:\/\//i.test(c.url)) p["Source URL"] = { url: c.url };
  if (CLASS_VALID.has(c.classification)) p["Classification"] = { select: { name: c.classification } };
  if (HORIZON_VALID.has(c.horizon)) p["Horizon"] = { select: { name: c.horizon } };
  if (SWIPES_VALID.has(c.swipes)) p["SWIPES"] = { select: { name: c.swipes } };
  if (origins.length) p["STEEP-V Origin"] = { multi_select: origins };
  if (themes.length) p["Themes"] = { multi_select: themes };
  if (keywords.length) p["Keywords"] = { multi_select: keywords };
  if (c.date && /^\d{4}-\d{2}-\d{2}/.test(c.date)) p["Date Found"] = { date: { start: c.date.slice(0, 10) } };
  if (c.author) p["Author"] = { rich_text: rt(c.author) };
  if (c.srctype) p["Source Type"] = { select: { name: String(c.srctype).slice(0, 90) } };
  if (MATURITY_VALID.has(c.maturity)) p["Maturity"] = { select: { name: c.maturity } };
  const likelihood = c.likelihood == null ? "" : String(c.likelihood).trim();
  if (DIGIT_VALID.has(likelihood)) p["Likelihood"] = { select: { name: likelihood } };
  const credibility = c.credibility == null ? "" : String(c.credibility).trim();
  if (DIGIT_VALID.has(credibility)) p["Credibility"] = { select: { name: credibility } };
  if (c.lens_retail) p["Lens — Retail Category"] = { rich_text: rt(c.lens_retail) };
  if (c.lens_shopper) p["Lens — Shopper Segment / VERGE"] = { rich_text: rt(c.lens_shopper) };
  // Signal Strength / Tests Met / Decision-at-stake are HUMAN-held — left blank on ingest.
  return p;
}

function buildBody(c) {
  const blocks = [];
  const para = (label, text) => {
    if (!text) return;
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [
      { type: "text", text: { content: label + ": " }, annotations: { bold: true } },
      { type: "text", text: { content: String(text).slice(0, 1900) } },
    ] } });
  };
  para("AI read (tentative)", c.ai_read || c.aiRead);
  para("Evidence", c.evidence);
  para("What's changing", c.shift);
  // extracted hyperlinks: primary url + every link in the nested sources[] array
  const links = [];
  if (c.url && /^https?:\/\//i.test(c.url)) links.push({ label: c.source || c.url, url: c.url });
  for (const s of (Array.isArray(c.sources) ? c.sources : [])) {
    if (s && s.url && /^https?:\/\//i.test(s.url)) links.push({ label: s.name || s.url, url: s.url });
  }
  const seen = new Set();
  const uniq = links.filter((l) => { const k = normUrl(l.url); if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniq.length) {
    blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "Extracted hyperlinks" } }] } });
    for (const l of uniq.slice(0, 40)) {
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [
        { type: "text", text: { content: String(l.label).slice(0, 200), link: { url: l.url } } },
      ] } });
    }
  }
  return blocks.slice(0, 90); // Notion caps children per create request
}

async function run() {
    let added = 0, skipped = 0, failed = 0, seenFiles = 0, tooOld = 0;
    const cutoff = Date.now() - 365 * 864e5; // rolling 1-year window — never sync anything older than this
  for (const [file, feed] of FILES) {
    if (!existsSync(file)) continue;
    seenFiles++;
    let payload;
    try { payload = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { console.error(`  ! could not parse ${file}: ${e.message}`); continue; }
    const cands = Array.isArray(payload) ? payload : (payload.candidates || []);
    console.log(`${file} (${feed}): ${cands.length} candidates`);
    for (const c of cands) {
      if (!c || (!c.title && !c.url)) continue;
      if (c.date) {
        const t = new Date(String(c.date).slice(0, 10)).getTime();
        if (!isNaN(t) && t < cutoff) { tooOld++; continue; }        // rolling window: skip anything older than 1 year
      }
      const sid = signalId(c);
      try {
        if (await exists(sid)) { skipped++; continue; }             // idempotent: never duplicate
        await notion("/pages", "POST", { parent: { database_id: DB }, properties: buildProps(c, feed), children: buildBody(c) });
        added++;
        await sleep(350);                                            // stay under ~3 req/s
      } catch (e) { failed++; console.error(`  ! ${(c.title || c.url || "").slice(0, 60)}: ${e.message}`); }
    }
  }
  if (!seenFiles) console.log("No candidate files found.");
    console.log(`\nNotion sync: ${added} new, ${skipped} already present, ${tooOld} older than the 1-year rolling window${failed ? `, ${failed} failed` : ""}.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
