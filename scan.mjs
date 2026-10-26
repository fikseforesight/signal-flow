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
// Parameterized so this same engine can also run the wild scan (different
// query config, different output file) without duplicating any feeder logic.
// Daily scan sets none of these, so its behavior is unchanged.
const SOURCES_FILE = process.env.SOURCES_FILE || "sources.json";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "candidates.json";
const SEEN_FILE = process.env.SEEN_FILE || "seen.json";
const ARCHIVE_PREFIX = process.env.ARCHIVE_PREFIX || "candidates";
const SRC = JSON.parse(readFileSync(join(ROOT, SOURCES_FILE), "utf8"));
// The wild scan is deliberately domain-agnostic — reaching into terrain the daily scan
// never touches is the entire point of it. So the built-environment relevance gate in
// the prompt below is applied to the DAILY scan only, never to wild.
const IS_WILD = /wild/i.test(SOURCES_FILE);
const CFG = SRC.config;
const DATA = ROOT;
const API_KEY = process.env.ANTHROPIC_API_KEY;
// Sources Kristen has ruled out as signal sources (Oct 2026: ArchDaily — project showcases, not change).
const BLOCKED = (CFG.blockedDomains || []).map((d) => d.toLowerCase().replace(/^www\./, ""));

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

// De-dup layer 1 of 2: claim fingerprint.
// The same story routinely arrives through two feeders under two different URLs (an
// arXiv paper via both arXiv and its Cornell mirror, an essay via both RSS and HN), and
// a URL hash cannot see that. So we also fingerprint the title: lowercase, drop
// punctuation and stopwords, singularise, keep the distinctive tokens, dedupe, sort,
// join. Sorting kills word order, so "Robots inherit dangerous labour" and "Dangerous
// labour inherited by robots" collapse to the same key.
//
// LIMIT, measured not assumed: this catches near-identical headlines only. Tested
// against five real duplicate pairs that reached the library, genuine paraphrases
// scored 0.00-0.40 token overlap — the same range as unrelated items — so no lexical
// threshold can separate them. Paraphrase duplicates are caught in layer 2 instead
// (the MERGE DUPLICATES rule in the prompt below), which has actual semantics.
// Titles with under 3 distinctive tokens return "" and fall back to URL-only de-dup
// rather than risk a false collision that would silently lose a real signal.
const STOPWORDS = new Set(
  "about after against along amid among another around because been before being between beyond both could does doing during each either enough every from have here into itself just like made make many more most much must never only other over same should since some such than that their them then there these they thing this those three through toward under until upon very what when where which while will with within without would your".split(" ")
);
const singular = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
function claimKey(title = "") {
  const toks = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .map(singular);
  const distinct = [...new Set(toks)].sort();
  if (distinct.length < 3) return "";
  return "claim:" + distinct.slice(0, 8).join("-");
}

async function get(url, asJson = true, headers = {}, timeoutMs = 20000) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "signal-flow-scan/1.0 (personal foresight tool)", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
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
  // Single newest-first (datedesc) pass — surfaces rising-but-small, peripheral-
  // geography, first-coverage items (the weak end). GDELT is flaky from datacenter
  // IPs, so cap the wait at 12s per call and fail fast rather than hang the job.
  for (const q of SRC.gdeltQueries) {
    const u = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=10&format=json&timespan=${CFG.gdeltTimespan}&sort=datedesc`;
    const j = await get(u, true, {}, 12000);
    for (const a of j?.articles || []) {
      out.push({ title: a.title, url: a.url, snippet: `${a.sourcecountry || ""} ${a.language || ""}`.trim(), source: a.domain, date: (a.seendate || "").slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"), feeder: "gdelt" });
    }
    await sleep(4000); // GDELT throttles hard
  }
  return out;
}

// niche/fringe communities — where weak signals surface before any outlet names them.
// Uses Reddit's Atom feed (the JSON API 403s datacenter IPs; the .rss feed does not).
async function reddit() {
  const out = [];
  for (const sub of SRC.subreddits || []) {
    const xml = await get(`https://www.reddit.com/r/${sub}/new/.rss`, false, { "user-agent": "signal-flow-scan/1.0 (personal foresight tool by u/signalflow)" });
    if (!xml) continue;
    for (const e of xml.split("<entry>").slice(1, 11)) {
      const pick = (tag) => {
        const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      };
      const link = (e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
      const date = pick("updated").slice(0, 10);
      if (date && (Date.now() - new Date(date).getTime()) / 864e5 > (CFG.redditDays || 4)) continue;
      const title = pick("title");
      if (!title || !link) continue;
      out.push({ title, url: link, snippet: pick("content").slice(0, 300), source: `r/${sub}`, date, feeder: "reddit" });
    }
    await sleep(2500);
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
      const authorNames = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
      const author = authorNames.slice(0, 3).join(", ") + (authorNames.length > 3 ? " et al." : "");
            out.push({ title: pick("title"), url: id, snippet: pick("summary").slice(0, 300), source: "arXiv", date, feeder: "arxiv", author });
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
                const authorNames = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
                const author = authorNames.slice(0, 3).join(", ") + (authorNames.length > 3 ? " et al." : "");
                out.push({ title: w.display_name, url: w.doi || w.id, snippet: (w.abstract_inverted_index ? Object.keys(w.abstract_inverted_index).slice(0, 40).join(" ") : ""), source: w.primary_location?.source?.display_name || "OpenAlex", date: w.publication_date, feeder: "openalex", author });
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
      const author = (pick("dc:creator") || pick("author")).slice(0, 120);
      // relevance gate (skipped when config.rssGate === false, since feeds are hand-picked idea sources)
      if (CFG.rssGate !== false) {
        const hay = (title + " " + snippet).toLowerCase();
        if (!SRC.relevanceKeywords.some((k) => hay.includes(k))) continue;
      }
            out.push({ title, url: link, snippet, source: f.name, date: date.toISOString().slice(0, 10), feeder: "rss", author });
    }
    await sleep(500);
  }
  return out;
}

// ---------- the AI pass ----------

async function claudePass(items, maxC = CFG.maxCandidates) {
  const sys = `You are the scanning funnel for Signal Flow, a strategic-foresight weak-signal tool. The human (Kristen) holds ALL qualification judgment; you widen and label.

Domain map: ${SRC.domainMap}

NON-NEGOTIABLE RULES:
- Never down-rank or drop an item for being implausible, fringe, uncomfortable, or low-consensus. Strangeness is evidence of signal.
- Prefer edges over headlines: absences, reframings, second-order implications, peripheral geography, single instances.
- Your reads are TENTATIVE SUGGESTIONS, never verdicts.
- Items that are clearly established trends or hype: still include the best of them, classification "Trend" or "Hype" (they will be filed to Context by the human).
- Do NOT assign an impact rating; that is human-held.
- A retrospective academic or literary critique/analysis of the past (no new discovery, nothing net-new or emerging — especially scholarship analyzing material from more than ~10 years ago) is NOT a signal. Exclude it entirely; do not add it to candidates, even at a low classification, regardless of how strange or fringe its framing is.
- Reddit items (especially r/Futurology) only qualify if the post itself cites or links concrete external evidence (a study, dataset, article, or named source). Exclude speculative, discussion-only posts with no cited evidence, even if the framing is interesting.
- MERGE DUPLICATES. If two or more raw items describe the same underlying finding, study, product, incident, or essay — even when the headlines are worded completely differently, or they arrive from different feeders under different URLs — emit exactly ONE candidate for it, citing the single strongest source. Never emit one finding twice under two names. This is on you: the upstream de-duplication matches URLs and near-identical titles, and cannot tell that two differently-worded headlines are the same story. You are the only place that can be caught.
${IS_WILD ? "" : `
BUILT-ENVIRONMENT RELEVANCE GATE (daily scan only):
Before keeping a candidate, name the physical or operational stake — what someone who builds, owns, operates, supplies, staffs, finances, insures, regulates, powers, or occupies physical space would have to do differently if this held.

Read that BROADLY. It counts if the change lands anywhere in the chain that produces or sustains physical space: sites and buildings, infrastructure and utilities, materials and construction methods, logistics and freight, energy and water, land and property, the labour that runs these places, the capital and insurance behind them, the codes and regulations governing them, or the people who move through and use them. Second-order effects fully count — a labour, capital, materials, mobility, climate, or demographic shift that would eventually reshape how space is built, used, staffed, or valued is IN scope. Where genuinely torn, keep it and let the human cut it.

What is OUT of scope: anything whose entire consequence stays inside a screen, a lab, a journal, or a discourse. AI and software news qualifies only where it changes something physical — a machine moving through a building, a sensor in a store, a system rerouting freight, a rule governing a site, a robot doing work a person did. General model releases, developer tooling, benchmark results, interpretability findings, and AI-safety debate do NOT qualify on their own. Neither does scholarship that only reinterprets a concept or reframes the past with nothing downstream changing.

State the stake in one concrete sentence or drop the candidate. Do not stretch to invent one — a strained justification is itself the signal that it does not belong.
`}

From the raw items, return AS MANY candidates as are at all worth Kristen's eye — up to ${maxC}, ordered weakest/strangest first. She wants VOLUME and wants to see the rule-outs, so also include borderline and already-trending items, but label those honestly with classification "Trend" or "Hype" and a one-line reason in ai_read. Never silently drop a plausibly-interesting item; include and label it. Keep "ai_read" and "evidence" under 45 words each. Return ONLY a JSON array, no prose, each element:
{"title": "short signal name (the shift, not the event)",
 "shift": "1-2 sentences on the underlying shift",
 "ai_read": "tentative read: why it might matter and why it is strange, labeled tentative",
 "evidence": "what supports it, from the item",
 "url": "...", "source": "...", "date": "YYYY-MM-DD",
 "horizon": "H1|H2|H3 — REQUIRED. Judge on evidence, never on strangeness: H1 = already reshaping current operations; H2 = an emerging transition with real instances, likely to matter in ~3-10 yrs; H3 = a seed of a different system, ~10-30 yrs. Do NOT default to H3 just because an item is odd",
 "domain_branch": "REQUIRED. One or two of: Labor & Operations | Supply Chain | Infrastructure | Construction | Retail Industry | Tech & AI | People & Human System | Policy & Finance | Sustainability & Environment | Off-map — joined with ' / '",
 "geography": "country or region where the change is actually happening (e.g. 'Japan', 'Gulf', 'US-Texas'), or 'Global'",
 "first_claim": "yes|plausible|no — is this credibly a FIRST (first law, first deployment, first instance anywhere or in a major market)?",
 "swipes": "Statistics|Writings|Innovations|Pitches|Entrants & exits|Superhits & outliers",
 "steep": "Social|Technological|Economic|Environmental|Political|Demographic",
 "steep2": "optional second, same enum or omit",
 "classification": "Weak signal|Wild card|Trend|Hype",
 "maturity": "Signal|Early indicator|Trigger — default Signal unless there is a concrete early indicator or a named trigger event",
 "likelihood": "0-5, tentative estimate of how likely this shift continues/materializes; 0=speculative, 5=already clearly underway",
 "credibility": "0-5, tentative source-credibility estimate for context only; 0=single unverified post, 5=peer-reviewed or official data",
 "lens_retail": "optional: retail/merchandising category ONLY if this clearly fits a retail lens (e.g. 'beauty', 'household'); omit the field entirely otherwise",
 "lens_shopper": "optional: VERGE lens (Define/Relate/Connect/Create/Consume/Destroy) and/or shopper segment ONLY if it clearly fits (e.g. 'value shopper / Consume'); omit the field entirely otherwise",
     "novelty": "High|Medium|Low — how unprecedented or unfamiliar this shift is, distinct from likelihood/credibility",
         "impact_scale": "Local|Regional|Global — how far the impact would spread if this signal materializes",
             "disruptive_potential": "Minor|Major|Catastrophic — magnitude of disruption if it plays out",
                 "initial_analysis": "2-3 sentences, tentative: what kind of change this is an example of (from what to what), what's driving it, and what the world would look like if it became common",
 "themes": ["..."], "keywords": ["..."]}`;

  const user = "Raw scan items (title | source | date | url | snippet):\n\n" +
    items.map((i, n) => `${n + 1}. ${i.title} | ${i.source} | ${i.date} | ${i.url} | ${i.snippet}`).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CFG.model, max_tokens: 20000, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*/);
  if (!m) throw new Error(`No JSON array in model response (stop_reason=${j.stop_reason}; starts: ${JSON.stringify(text.slice(0, 300))})`);
  // salvage parse: if the response was truncated mid-object, trim back to the
  // last complete object boundary and close the array — never lose a whole batch
  const raw = m[0];
  let end = raw.length;
  while (end > 2) {
    const slice = raw.slice(0, end).replace(/[\s,\]]+$/, "");
    try { return JSON.parse(slice + "]"); } catch {}
    end = raw.lastIndexOf("}", end - 2) + 1;
    if (end <= 0) break;
  }
  throw new Error("Could not parse model response as JSON");
}

// Batched, retrying AI pass. Before Oct 2026 the whole day's items went in one request,
// and a single malformed reply crashed the scan and lost the day (9 crashes Sept 14-Oct 1).
// Now: ~40 items per request, 3 tries per batch, and a failed batch is logged and skipped
// instead of killing the run.
let FAILED_BATCHES = 0, LAST_AI_ERROR = "";
async function claudePassBatched(items) {
  const BATCH = 40;
  const out = [];
  let failedBatches = 0;
  for (let s = 0; s < items.length; s += BATCH) {
    const chunk = items.slice(s, s + BATCH);
    const maxC = Math.max(5, Math.ceil(CFG.maxCandidates * chunk.length / items.length));
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const r = await claudePass(chunk, maxC);
        out.push(...r);
        console.log(`  batch ${s / BATCH + 1}: ${r.length} candidates`);
        done = true;
      } catch (e) {
        LAST_AI_ERROR = e.message;
        console.error(`  batch ${s / BATCH + 1} attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await sleep(5000 * attempt);
      }
    }
    if (!done) { failedBatches++; FAILED_BATCHES++; }
  }
  if (failedBatches && !out.length) throw new Error(`All ${failedBatches} AI batches failed. Last error: ${LAST_AI_ERROR}`);
  return out;
}

// ---------- the critique pass (adversarial demotion gate) ----------
// Oct 2026: the first pass is told to widen, and an AI that widens also over-rates its own
// finds — in a manual audit of 253 kept items, only 27 survived as genuine firsts/weak signals.
// So every Weak signal / Wild card now goes through a second, hostile pass whose ONLY job is to
// prove the item is already known. It runs the same six-question demotion bar Kristen uses.
// It can demote (to Trend/Hype); it can never promote, and it never deletes.
async function critiquePass(cands) {
  const pool = cands.map((c, i) => ({ c, i })).filter(({ c }) => c.classification === "Weak signal" || c.classification === "Wild card");
  if (!pool.length) return { checked: 0, demoted: 0 };
  const sys = `You are the adversarial critique analyst for a strategic-foresight weak-signal library. Default posture: DEMOTION. For each candidate, actively try to prove it has ALREADY cleared the weak-signal bar — i.e. that it is a known, named, counted thing.

Weakness = how LITTLE-KNOWN a change is, not how strange it sounds. Answer six tests for each, using your own knowledge plus the evidence given:
1 named: does the shift already have a coined, widely-used name?
2 codified: is it backed by law, standard, code, or formal programme in more than one place?
3 counted: is there survey, market or analyst data quantifying it?
4 mainstream: has it had mainstream national/international press (not trade press) coverage?
5 multiple: are there multiple independent instances (3+), not one?
6 practitioners: do practitioners in the field already use a trend name for it?
Answer each "yes", "no" or "unknown". Use "unknown" honestly when you cannot tell (e.g. after your knowledge cutoff) — unknown is NOT yes.

Verdict: "keep" if 0-2 yes; "demote" if 3+ yes. Also judge "first": is this credibly a world/national/major-market FIRST? (yes|plausible|no). Also flag "mismatch": true if the title claims more than the evidence supports.
Return ONLY a JSON array, one object per candidate, same order:
{"id": <number given>, "tests": {"named":"","codified":"","counted":"","mainstream":"","multiple":"","practitioners":""}, "verdict": "keep|demote", "first": "yes|plausible|no", "mismatch": false, "why": "max 30 words: the strongest reason it is or is not already known"}`;
  let checked = 0, demoted = 0;
  for (let s = 0; s < pool.length; s += 25) {
    const chunk = pool.slice(s, s + 25);
    const user = chunk.map(({ c, i }) => `id ${i}: ${c.title} — shift: ${c.shift || ""} — evidence: ${c.evidence || ""} — source: ${c.source || ""} (${c.date || ""})`).join("\n");
    let arr = null;
    for (let attempt = 1; attempt <= 2 && !arr; attempt++) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: CFG.critiqueModel || CFG.model, max_tokens: 8000, system: sys, messages: [{ role: "user", content: user }] }),
        });
        if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const j = await res.json();
        const text = (j.content || []).map((b) => b.text || "").join("");
        arr = JSON.parse((text.match(/\[[\s\S]*\]/) || ["[]"])[0]);
      } catch (e) { console.error(`  critique chunk ${s / 25 + 1} attempt ${attempt} failed: ${e.message}`); }
    }
    for (const r of arr || []) {
      const c = cands[r.id];
      if (!c || !r.tests) continue;
      const yes = Object.values(r.tests).filter((v) => String(v).toLowerCase() === "yes").length;
      const unknown = Object.values(r.tests).filter((v) => String(v).toLowerCase() === "unknown").length;
      // Weakness = number of tests answered a firm "no" (unknowns don't count either way).
      // 6 = no trace of it being known; 0 = fully established.
      c.weakness = Object.values(r.tests).filter((v) => String(v).toLowerCase() === "no").length;
      c.first_claim = r.first || c.first_claim;
      const testsLine = Object.entries(r.tests).map(([k, v]) => `${k}:${v}`).join(" ");
      c.critique = `${r.verdict === "demote" || yes >= 3 ? "DEMOTE" : "KEEP"} (${yes}/6 known${unknown ? `, ${unknown} unknown` : ""}) — ${r.why || ""} [${testsLine}]${r.mismatch ? " ⚠ title overstates evidence" : ""}`;
      if (yes >= 3) {
        c.original_classification = c.classification;
        c.classification = "Trend";
        c.ai_read = `[Critique demoted: ${r.why || "already known"}] ` + (c.ai_read || "");
        demoted++;
      }
      checked++;
    }
  }
  return { checked, demoted };
}

// ---------- main ----------

const seenPath = join(DATA, SEEN_FILE);
const seen = new Set(existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")) : []);

// RE-TRIAGE MODE (Oct 2026): RAW_INPUT_FILE points at items exported from Notion that were
// saved untriaged during an AI outage. Feeders and seen-memory are skipped; the same triage +
// critique passes run on them. retriage.mjs then writes the results back onto the same pages.
const RAW_INPUT = process.env.RAW_INPUT_FILE;
if (RAW_INPUT) {
  const n = JSON.parse(readFileSync(RAW_INPUT, "utf8")).length;
  CFG.maxRawItems = n;
  CFG.maxCandidates = Math.max(5, Math.ceil(n * Number(process.env.KEEP_RATIO || 0.25)));
}
console.log(RAW_INPUT ? `Re-triage mode: ${RAW_INPUT}` : "Pulling feeders…");
const results = RAW_INPUT ? JSON.parse(readFileSync(RAW_INPUT, "utf8")) : [];
for (const [name, fn] of RAW_INPUT ? [] : [["gdelt", gdelt], ["arxiv", arxiv], ["openalex", openalex], ["hn", hackernews], ["reddit", reddit], ["rss", rss]]) {
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
  if (!k || !it.title || (!RAW_INPUT && seen.has(k)) || inBatch.has(k)) continue;
  if (BLOCKED.some((d) => k.startsWith(d) || k.includes("." + d))) continue; // blocked sources (e.g. ArchDaily)
  if (/\/spons\/|\/sponsored\//.test(k)) continue;                               // paid/sponsored posts are not signals
  const ck = claimKey(it.title);
  if (ck && ((!RAW_INPUT && seen.has(ck)) || inBatch.has(ck))) continue;
  inBatch.add(k);
  if (ck) inBatch.add(ck);
  fresh.push(it);
}
console.log(`${results.length} raw → ${fresh.length} unseen`);

// Round-robin across feeders before capping. Previously fresh.slice(0, cap) kept items in
// feeder order (gdelt, arxiv, openalex, hn, reddit, rss), so on busy days the hand-picked RSS
// feeds — the best sources — were the ones cut. Interleaving gives every feeder a fair share.
const byFeeder = new Map();
for (const it of fresh) { if (!byFeeder.has(it.feeder)) byFeeder.set(it.feeder, []); byFeeder.get(it.feeder).push(it); }
const interleaved = [];
for (let i = 0; interleaved.length < fresh.length; i++) for (const arr of byFeeder.values()) if (arr[i]) interleaved.push(arr[i]);
const capped = interleaved.slice(0, CFG.maxRawItems);
let candidates = [];
// Run status is written to scan-status.json so the workflow can (a) open an alert issue and
// (b) turn the run RED when the AI pass fails. Before Oct 2026 a failed AI pass (e.g. API out
// of credits, Oct 3-18) fell back to raw items and the run stayed green — nobody noticed for 2 weeks.
const status = { date: today, feed: ARCHIVE_PREFIX, raw: results.length, unseen: fresh.length, sent: capped.length, ai: "skipped", error: "", critique: null };
if (capped.length && API_KEY) {
  console.log(`AI pass on ${capped.length} items…`);
  try {
    candidates = await claudePassBatched(capped);
    status.ai = "ok";
    if (CFG.critique !== false) {
      console.log("Critique pass…");
      status.critique = await critiquePass(candidates);
      console.log(`  critique: ${status.critique.checked} checked, ${status.critique.demoted} demoted to Trend`);
    }
  } catch (err) {
    status.ai = "failed"; status.error = err.message.slice(0, 400);
    console.error(`AI pass failed entirely (${err.message}) — writing raw items as bare candidates so the day is not lost.`);
    candidates = capped.slice(0, CFG.maxCandidates).map((i) => ({
      title: i.title, shift: "", ai_read: "(AI pass failed — raw feed item, needs manual triage)", evidence: i.snippet,
      url: i.url, source: i.source, date: i.date, srctype: "import", classification: "", themes: [], keywords: [],
    }));
  }
  console.log(`  ${candidates.length} candidates drafted`);
} else if (!API_KEY) {
  status.ai = "no-key"; status.error = "ANTHROPIC_API_KEY secret is missing";
  console.error("ANTHROPIC_API_KEY missing — writing raw items as bare candidates.");
  candidates = capped.slice(0, CFG.maxCandidates).map((i) => ({
    title: i.title, shift: "", ai_read: "(no AI pass — raw feed item)", evidence: i.snippet,
    url: i.url, source: i.source, date: i.date, srctype: "import", classification: "", themes: [], keywords: [],
  }));
}
// Author and Source Type are never AI-guessed — attach them post-hoc from real pipeline
// metadata (arXiv/OpenAlex author lists, RSS dc:creator/author tags, and the feeder that
// actually found the item) by matching the candidate back to its raw item.
const authorByUrl = new Map(capped.filter((i) => i.author).map((i) => [normUrl(i.url), i.author]));
const feederByUrl = new Map(capped.map((i) => [normUrl(i.url), i.feeder]));
for (const c of candidates) {
  const a = authorByUrl.get(normUrl(c.url));
  if (a && !c.author) c.author = a;
  const f = feederByUrl.get(normUrl(c.url));
  if (f) c.srctype = f;
}
if (RAW_INPUT) {
  const pageByUrl = new Map(capped.filter((i) => i.page_id).map((i) => [normUrl(i.url), i.page_id]));
  for (const c of candidates) { const p = pageByUrl.get(normUrl(c.url)); if (p) c.page_id = p; }
}

// mark everything pulled this run as seen (candidates AND non-selected, so tomorrow is fresh)
// Two keys per item now (url + claim), so seenLimit buys roughly half as many runs of
// de-dup memory as it used to. Raise seenLimit in sources.json if repeats reappear.
for (const it of capped) {
  seen.add(normUrl(it.url));
  const ck = claimKey(it.title);
  if (ck) seen.add(ck);
}
for (const c of candidates) {
  if (c.url) seen.add(normUrl(c.url));
  const ck = claimKey(c.title);
  if (ck) seen.add(ck);
}

mkdirSync(join(DATA, "archive"), { recursive: true });
const payload = { generated: new Date().toISOString(), batch: today, candidates };
writeFileSync(join(DATA, OUTPUT_FILE), JSON.stringify(payload, null, 1));
writeFileSync(join(DATA, "archive", `${ARCHIVE_PREFIX}-${today}.json`), JSON.stringify(payload, null, 1));
if (!RAW_INPUT) writeFileSync(seenPath, JSON.stringify([...seen].slice(-CFG.seenLimit), null, 0));
console.log(`Wrote ${candidates.length} candidates for ${today} → ${OUTPUT_FILE}.`);
status.candidates = candidates.length;
status.failedBatches = FAILED_BATCHES;
if (status.ai === "ok" && FAILED_BATCHES) status.ai = "partial";
writeFileSync(join(DATA, "scan-status.json"), JSON.stringify(status, null, 1));
