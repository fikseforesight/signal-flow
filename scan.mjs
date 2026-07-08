// Signal Flow — daily scan engine.
// Runs in GitHub Actions (or locally: ANTHROPIC_API_KEY=... node scan/scan.mjs).
// Pulls GDELT / arXiv / OpenAlex / Hacker News / RSS per sources.json,
// de-dupes against seen.json, asks Claude for tentative reads
// (anti-consensus rules embedded), writes candidates.json.
// Dependency-free: Node 20+ only.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
const CFG = SRC.config;
const DATA = ROOT;
const API_KEY = process.env.ANTHROPIC_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u.trim());
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

async function get(url, asJson = true, headers = {}) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "signal-flow-scan/1.0 (personal foresight tool)", ...headers }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) { console.error(`  ! ${res.status} ${url.slice(0, 90)}`); return null; }
    return asJson ? await res.json() : await res.text();
  } catch (e) {
    console.error(`  ! fetch failed ${url.slice(0, 90)}: ${e.message}`);
    return null;
  }
}

// ---------- feeders (each returns [{title,url,snippet,source,date,feeder}]) ----------

async function gdelt() {
  const out = [];
  for (const q of SRC.gdeltQueries) {
    const u = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=8&format=json&timespan=${CFG.gdeltTimespan}&sort=hybridrel`;
    const j = await get(u);
    for (const a of j?.articles || []) {
      out.push({ title: a.title, url: a.url, snippet: `${a.sourcecountry || ""} ${a.language || ""}`.trim(), source: a.domain, date: (a.seendate || "").slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), feeder: "gdelt" });
    }
    await sleep(6000); // GDELT throttles hard
  }
  return out;
}

async function arxiv() {
  const out = [];
  for (const q of SRC.arxivQueries) {
    const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=5`;
    const xml = await get(u, false);
    if (!xml) continue;
    for (const entry of xml.split("<entry>").slice(1)) {
      const pick = (tag) => (entry.split(`<${tag}>`)[1] || "").split(`</${tag}>`)[0].replace(/\s+/g, " ").trim();
      const date = pick("published").slice(0, 10);
      const ageDays = (Date.now() - new Date(date).getTime()) / 864e5;
      if (ageDays > CFG.arxivDays) continue;
      const id = pick("id");
      out.push({ title: pick("title"), url: id, snippet: pick("summary").slice(0, 300), source: "arXiv", date, feeder: "arxiv" });
    }
    await sleep(3000);
  }
  return out;
}

async function openalex() {
  const out = [];
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  for (const q of SRC.openalexQueries) {
    const u = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=from_publication_date:${from}&per-page=5&sort=publication_date:desc`;
    const j = await get(u);
    for (const w of j?.results || []) {
      out.push({ title: w.display_name, url: w.doi || w.id, snippet: (w.abstract_inverted_index ? Object.keys(w.abstract_inverted_index).slice(0, 40).join(" ") : ""), source: w.primary_location?.source?.display_name || "OpenAlex", date: w.publication_date, feeder: "openalex" });
    }
    await sleep(1000);
  }
  return out;
}

async function hackernews() {
  const out = [];
  const since = Math.floor(Date.now() / 1000) - CFG.hnDays * 86400;
  for (const q of SRC.hnQueries) {
    const u = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=5`;
    const j = await get(u);
    for (const h of j?.hits || []) {
      out.push({ title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, snippet: `${h.points} points, ${h.num_comments} comments`, source: "Hacker News", date: (h.created_at || "").slice(0, 10), feeder: "hn" });
    }
    await sleep(500);
  }
  return out;
}

async function rss() {
  const out = [];
  for (const f of SRC.rssFeeds) {
    const xml = await get(f.url, false);
    if (!xml) continue;
    const items = xml.split(/<item[\s>]/).slice(1, 12);
    for (const it of items) {
      const pick = (tag) => {
        const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      };
      const link = pick("link") || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
      const date = new Date(pick("pubDate") || pick("dc:date") || Date.now());
      if ((Date.now() - date.getTime()) / 864e5 > 2) continue; // last 48h only
      const title = pick("title"), snippet = pick("description").slice(0, 300);
      // cheap relevance gate so general design/tech feeds don't flood the LLM pass
      const hay = (title + " " + snippet).toLowerCase();
      if (!SRC.relevanceKeywords.some((k) => hay.includes(k))) continue;
      out.push({ title, url: link, snippet, source: f.name, date: date.toISOString().slice(0, 10), feeder: "rss" });
    }
    await sleep(500);
  }
  return out;
}

// ---------- the AI pass ----------

async function claudePass(items) {
  const sys = `You are the scanning funnel for Signal Flow, a strategic-foresight weak-signal tool. The human (Kristen) holds ALL qualification judgment; you widen and label.

Domain map: ${SRC.domainMap}

NON-NEGOTIABLE RULES:
- Never down-rank or drop an item for being implausible, fringe, uncomfortable, or low-consensus. Strangeness is evidence of signal.
- Prefer edges over headlines: absences, reframings, second-order implications, peripheral geography, single instances.
- Your reads are TENTATIVE SUGGESTIONS, never verdicts.
- Items that are clearly established trends or hype: still include the best of them, classification "Trend" or "Hype" (they will be filed to Context by the human).
- Do NOT assign an impact rating; that is human-held.

From the raw items, select up to ${CFG.maxCandidates} candidates relevant to the domain map (weakest/strangest first). Return ONLY a JSON array, no prose, each element:
{"title": "short signal name (the shift, not the event)",
 "shift": "1-2 sentences on the underlying shift",
 "ai_read": "tentative read: why it might matter and why it is strange, labeled tentative",
 "evidence": "what supports it, from the item",
 "url": "...", "source": "...", "date": "YYYY-MM-DD",
 "srctype": "gdelt|rss|import",
 "swipes": "Statistics|Writings|Innovations|Pitches|Entrants & exits|Superhits & outliers",
 "steep": "Social|Technological|Economic|Environmental|Political|Demographic",
 "steep2": "optional second, same enum or omit",
 "classification": "Weak signal|Wild card|Trend|Hype",
 "themes": ["..."], "keywords": ["..."]}`;

  const user = "Raw scan items (title | source | date | url | snippet):\n\n" +
    items.map((i, n) => `${n + 1}. ${i.title} | ${i.source} | ${i.date} | ${i.url} | ${i.snippet}`).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CFG.model, max_tokens: 8000, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("No JSON array in model response");
  return JSON.parse(m[0]);
}

// ---------- main ----------

const seenPath = join(DATA, "seen.json");
const seen = new Set(existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")) : []);

console.log("Pulling feeders…");
const results = [];
for (const [name, fn] of [["gdelt", gdelt], ["arxiv", arxiv], ["openalex", openalex], ["hn", hackernews], ["rss", rss]]) {
  try {
    const r = await fn();
    console.log(`  ${name}: ${r.length} items`);
    results.push(...r);
  } catch (e) {
    console.error(`  ${name} failed entirely: ${e.message}`); // one broken feeder never kills the scan
  }
}

// de-dupe within batch and against history
const fresh = [];
const inBatch = new Set();
for (const it of results) {
  const k = normUrl(it.url);
  if (!k || !it.title || seen.has(k) || inBatch.has(k)) continue;
  inBatch.add(k);
  fresh.push(it);
}
console.log(`${results.length} raw → ${fresh.length} unseen`);

const capped = fresh.slice(0, CFG.maxRawItems);
let candidates = [];
if (capped.length && API_KEY) {
  console.log(`AI pass on ${capped.length} items…`);
  candidates = await claudePass(capped);
  console.log(`  ${candidates.length} candidates drafted`);
} else if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY missing — writing raw items as bare candidates.");
  candidates = capped.slice(0, CFG.maxCandidates).map((i) => ({
    title: i.title, shift: "", ai_read: "(no AI pass — raw feed item)", evidence: i.snippet,
    url: i.url, source: i.source, date: i.date, srctype: "import", classification: "", themes: [], keywords: [],
  }));
}

// mark everything pulled this run as seen (candidates AND non-selected, so tomorrow is fresh)
for (const it of capped) seen.add(normUrl(it.url));
for (const c of candidates) if (c.url) seen.add(normUrl(c.url));

mkdirSync(join(DATA, "archive"), { recursive: true });
const payload = { generated: new Date().toISOString(), batch: today, candidates };
writeFileSync(join(DATA, "candidates.json"), JSON.stringify(payload, null, 1));
writeFileSync(join(DATA, "archive", `candidates-${today}.json`), JSON.stringify(payload, null, 1));
writeFileSync(seenPath, JSON.stringify([...seen].slice(-CFG.seenLimit), null, 0));
console.log(`Wrote ${candidates.length} candidates for ${today}.`);
