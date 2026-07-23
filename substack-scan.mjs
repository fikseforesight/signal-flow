// Signal Flow — weekly Substack scan engine.
// Runs in GitHub Actions (or locally: ANTHROPIC_API_KEY=... node substack-scan.mjs).
// Reads substack-feeds.txt (Kristen's 412 subscriptions), rotates through a batch
// each run via substack-cursor.json (full sweep every ~6 weeks), fetches the actual
// article content + embedded hyperlinks (not just headlines), runs a cheap Haiku
// triage pass then a Sonnet deep read, writes substack-candidates.json.
// Dependency-free: Node 20+ only.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-5";

const BATCH_SIZE = Number(process.env.SUBSTACK_BATCH_SIZE || 70);
const RECENT_DAYS = 10;          // only consider articles published in the last N days
const MAX_ITEMS_PER_FEED = 2;    // cap per-feed volume
const MAX_LINKS_PER_ITEM = 8;
const TRIAGE_THRESHOLD = 45;     // above this many raw items, run the Haiku triage pass first
const SEEN_LIMIT = 6000;

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

async function get(url, asJson = false, headers = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "signal-flow-scan/1.0 (personal foresight tool)", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { console.error(`  ! ${res.status} ${url.slice(0, 90)}`); return null; }
    return asJson ? await res.json() : await res.text();
  } catch (e) {
    console.error(`  ! fetch failed ${url.slice(0, 90)}: ${e.message}`);
    return null;
  }
}

function stripHtml(html) {
  return (html || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

const BOILERPLATE_LINK = /\/(subscribe|comments?|about|profile|share|sign-?up|account)(\/|$|\?)|utm_source=substack|substack\.com\/notes/i;

function extractLinks(html, articleUrl) {
  const out = [];
  const seen = new Set();
  const selfHost = (() => { try { return new URL(articleUrl).hostname; } catch { return ""; } })();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_LINKS_PER_ITEM * 3) {
    const url = m[1];
    if (!/^https?:\/\//i.test(url)) continue;
    if (BOILERPLATE_LINK.test(url)) continue;
    let host = "";
    try { host = new URL(url).hostname; } catch { continue; }
    if (host === selfHost) continue; // skip self-referential links back into the same newsletter
    const key = normUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = stripHtml(m[2]).slice(0, 90) || host;
    out.push({ name: label, url });
  }
  return out.slice(0, MAX_LINKS_PER_ITEM);
}

// Generic RSS/Atom item parser — Substack feeds are RSS with <content:encoded> full HTML.
function parseFeedItems(xml, feedUrl) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const raw of blocks.slice(0, 8)) {
    const it = raw.split(/<\/item>/)[0];
    const pick = (tag) => {
      const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1] : "";
    };
    const title = stripHtml(pick("title"));
    const link = stripHtml(pick("link")) || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const pubDate = pick("pubDate") || pick("dc:date") || pick("published");
    const contentHtml = pick("content:encoded") || pick("description") || pick("summary");
    const author = stripHtml(pick("dc:creator") || pick("author")).slice(0, 120);
    if (!title || !link) continue;
    items.push({ title, link, pubDate, contentHtml, channelUrl: feedUrl, author });
  }
  return items;
}

function feedSourceName(feedUrl) {
  try { return new URL(feedUrl).hostname.replace(/^www\./, "").replace(/\.substack\.com$/, ""); } catch { return feedUrl; }
}

// ---------- cursor + seen state ----------

const cursorPath = join(ROOT, "substack-cursor.json");
const seenPath = join(ROOT, "substack-seen.json");

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

const cursor = loadJson(cursorPath, { index: 0 });
const seen = new Set(loadJson(seenPath, []));

// ---------- Claude passes ----------

async function callClaude(model, sys, user, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return (j.content || []).map((b) => b.text || "").join("");
}

function salvageJsonArray(text) {
  const m = text.match(/\[[\s\S]*/);
  if (!m) throw new Error("No JSON array in model response");
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

// Cheap relevance/junk filter over ALL fetched items — NOT a weak-signal judgment call,
// just cuts pure ads, link-roundups with no substantive idea, and routine event reporting.
// Errs toward keeping when unsure (that judgment belongs to the Sonnet pass and to Kristen).
async function triageHaiku(items) {
  const sys = `You are a cheap first-pass filter for a strategic-foresight scanning tool. From the list below, return the 1-based indices of items worth a DEEP read for weak-signal potential. Only cut items that are pure advertising, a bare link-roundup with no argument or idea, routine event/product announcements, or content unrelated to any substantive claim about how something is changing. When unsure, KEEP it — err toward inclusion. Return ONLY a JSON array of integers, e.g. [1,3,4,7].`;
  const user = items.map((i, n) => `${n + 1}. ${i.title} — ${i.snippetShort}`).join("\n");
  const text = await callClaude(HAIKU_MODEL, sys, user, 2000);
  try {
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return new Set(arr.filter((n) => Number.isInteger(n)));
  } catch {
    return new Set(items.map((_, n) => n + 1)); // triage failure → keep everything, fail open
  }
}

async function deepReadSonnet(items) {
  const sys = `You are the scanning funnel for Signal Flow, a strategic-foresight weak-signal tool. The human (Kristen) holds ALL qualification judgment; you widen and label. This batch is drawn from her Substack subscriptions — you're reading real essay content, not just headlines, and each item includes hyperlinks the author embedded, which are often where the actual signal lives (a cited study, an obscure project, a primary source).

NON-NEGOTIABLE RULES:
- Never down-rank or drop an item for being implausible, fringe, uncomfortable, or low-consensus. Strangeness is evidence of signal.
- Prefer edges over headlines: absences, reframings, second-order implications, peripheral geography, single instances.
- Weigh the embedded hyperlinks — if one points to something stranger or more concrete than the essay's own framing, that may BE the signal.
- Your reads are TENTATIVE SUGGESTIONS, never verdicts.
- Items that are clearly established trends or hype: still include the best of them, classification "Trend" or "Hype".
- Do NOT assign an impact rating; that is human-held.

Return AS MANY candidates as are at all worth Kristen's eye, ordered weakest/strangest first. Never silently drop a plausibly-interesting item. Keep "ai_read" and "evidence" under 45 words each. Return ONLY a JSON array, no prose, each element:
{"title": "short signal name (the shift, not the event)",
 "shift": "1-2 sentences on the underlying shift",
 "ai_read": "tentative read: why it might matter and why it is strange, labeled tentative",
 "evidence": "what supports it, from the essay or its links",
 "url": "the essay URL", "source": "newsletter name", "date": "YYYY-MM-DD",
 "horizon": "H1|H2|H3 — REQUIRED; bias to H3 (10-30yr) for weak/civilizational signals",
 "srctype": "substack",
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
 "themes": ["..."], "keywords": ["..."],
 "sources": [{"name": "label", "url": "..."}] }`;

  const user = items.map((i, n) =>
    `${n + 1}. TITLE: ${i.title}\nNEWSLETTER: ${i.source}\nDATE: ${i.date}\nURL: ${i.url}\nCONTENT: ${i.snippetLong}\nEMBEDDED LINKS: ${i.links.map((l) => `${l.name} (${l.url})`).join("; ") || "none"}\n`
  ).join("\n---\n");

  const text = await callClaude(SONNET_MODEL, sys, user, 20000);
  return salvageJsonArray(text);
}

// ---------- main ----------

const feedsPath = join(ROOT, "substack-feeds.txt");
const allFeeds = existsSync(feedsPath)
  ? readFileSync(feedsPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : [];

if (!allFeeds.length) {
  console.error("No substack-feeds.txt found in the repo root. Nothing to scan.");
  process.exit(0);
}

const start = cursor.index % allFeeds.length;
const batch = [];
for (let i = 0; i < Math.min(BATCH_SIZE, allFeeds.length); i++) batch.push(allFeeds[(start + i) % allFeeds.length]);
console.log(`Substack scan: feeds ${start}-${(start + batch.length - 1) % allFeeds.length} of ${allFeeds.length} (batch ${batch.length}).`);

const rawItems = [];
for (const feedUrl of batch) {
  const xml = await get(feedUrl, false, {}, 12000);
  if (!xml) continue;
  const parsed = parseFeedItems(xml, feedUrl);
  const sourceName = feedSourceName(feedUrl);
  let kept = 0;
  for (const it of parsed) {
    if (kept >= MAX_ITEMS_PER_FEED) break;
    const date = new Date(it.pubDate || Date.now());
    const ageDays = (Date.now() - date.getTime()) / 864e5;
    if (!isFinite(ageDays) || ageDays > RECENT_DAYS) continue;
    const key = normUrl(it.link);
    if (!key || seen.has(key)) continue;
    const plain = stripHtml(it.contentHtml);
    rawItems.push({
      title: it.title,
      url: it.link,
      source: sourceName,
      date: isNaN(date.getTime()) ? today : date.toISOString().slice(0, 10),
      snippetShort: plain.slice(0, 220),
      snippetLong: plain.slice(0, 900),
      links: extractLinks(it.contentHtml, it.link),
      author: it.author,
    });
    kept++;
  }
  await sleep(400);
}
console.log(`Fetched ${batch.length} feeds → ${rawItems.length} fresh articles (last ${RECENT_DAYS}d, unseen).`);

let candidates = [];
if (rawItems.length && API_KEY) {
  let toRead = rawItems;
  if (rawItems.length > TRIAGE_THRESHOLD) {
    console.log(`Triage pass (Haiku) over ${rawItems.length} items…`);
    const keepIdx = await triageHaiku(rawItems);
    toRead = rawItems.filter((_, n) => keepIdx.has(n + 1));
    console.log(`  kept ${toRead.length} of ${rawItems.length}`);
  }
  if (toRead.length) {
    console.log(`Deep read (Sonnet) on ${toRead.length} items…`);
    candidates = await deepReadSonnet(toRead);
    console.log(`  ${candidates.length} candidates drafted`);
  }
} else if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY missing — writing raw items as bare candidates.");
  candidates = rawItems.map((i) => ({
    title: i.title, shift: "", ai_read: "(no AI pass — raw feed item)", evidence: i.snippetShort,
    url: i.url, source: i.source, date: i.date, srctype: "substack", classification: "", themes: [], keywords: [],
    sources: i.links,
  }));
}

// Author is never AI-guessed — attach it post-hoc from the real dc:creator/author tag
// on the feed item, by matching the candidate back to its raw article.
const authorByUrl = new Map(rawItems.filter((i) => i.author).map((i) => [normUrl(i.url), i.author]));
for (const c of candidates) {
  const a = authorByUrl.get(normUrl(c.url));
  if (a && !c.author) c.author = a;
}
for (const it of rawItems) seen.add(normUrl(it.url));

const payload = { generated: new Date().toISOString(), batch: today, candidates };
writeFileSync(join(ROOT, "substack-candidates.json"), JSON.stringify(payload, null, 1));
writeFileSync(seenPath, JSON.stringify([...seen].slice(-SEEN_LIMIT), null, 0));
writeFileSync(cursorPath, JSON.stringify({ index: (start + batch.length) % allFeeds.length, lastRun: today, feedsTotal: allFeeds.length }, null, 1));
console.log(`Wrote ${candidates.length} substack candidates for ${today}. Cursor advanced to ${(start + batch.length) % allFeeds.length}/${allFeeds.length}.`);
