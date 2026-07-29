// Signal Flow — Raindrop → Notion Reference Library importer.
// Reads a Raindrop CSV export (Raindrop: Settings → Export → CSV) committed to the repo
// root as raindrop-export.csv, and upserts it into the Reference Library database.
//
// This is deliberately NOT a scan lane. Raindrop items never enter the triage queue —
// they are the corroboration layer. Reason: ~77% of the collection is tagged H1 by
// Kristen's own hand, i.e. near-term/trend material, which would fail the weak-signal
// bar on arrival and rebuild the inbox problem the triage rebuild just removed. Instead
// each item is linked to the signals it corroborates via the Signals relation.
//
// Usage: NOTION_TOKEN=... NOTION_REFERENCE_DB_ID=... node raindrop-import.mjs [csvPath]
// Dependency-free: Node 20+ only.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const TOKEN = process.env.NOTION_TOKEN;
const DS_ID = process.env.NOTION_REFERENCE_DB_ID;
const CSV = process.argv[2] || "raindrop-export.csv";
const DRY = process.env.DRY_RUN === "1";
const COLLECTION_DEFAULT = process.env.RAINDROP_COLLECTION || "Buildings Physical Space Store";
const NOTION_VERSION = "2022-06-28";

// ---------- CSV ----------
// Hand-rolled because the export contains quoted fields with embedded commas AND
// embedded newlines (highlights and notes routinely span lines), which a naive
// split(",") mangles silently — the failure mode is shifted columns, not an error.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function toObjects(rows) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const pick = (names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
  const idx = {
    title: pick(["title", "name"]),
    url: pick(["url", "link"]),
    tags: pick(["tags", "tag"]),
    note: pick(["note", "notes"]),
    excerpt: pick(["excerpt", "description"]),
    created: pick(["created", "date", "createdat"]),
    folder: pick(["folder", "collection"]),
    highlights: pick(["highlights", "highlight"]),
    id: pick(["id", "_id", "raindrop id"]),
  };
  if (idx.url === -1) throw new Error(`No url column found. Header was: ${header.join(", ")}`);
  const get = (r, i) => (i === -1 ? "" : (r[i] || "").trim());
  return rows.slice(1).map((r) => ({
    title: get(r, idx.title),
    url: get(r, idx.url),
    tags: get(r, idx.tags),
    note: get(r, idx.note),
    excerpt: get(r, idx.excerpt),
    created: get(r, idx.created),
    folder: get(r, idx.folder),
    highlights: get(r, idx.highlights),
    id: get(r, idx.id),
  })).filter((x) => x.url);
}

// ---------- tag mapping ----------
const STEEP = ["Social", "Technological", "Economic", "Environmental", "Political", "Demographic", "Values"];

// Kristen tags horizon both as a bare tag ("H1") and buried inside a compound tag
// ("entertainment multiuse H1"), so match on a word boundary rather than equality.
function horizonOf(tags) {
  for (const t of tags) {
    const m = t.match(/\bH([123])\b/i);
    if (m) return "H" + m[1];
  }
  return null;
}

function steepOf(tags) {
  const low = tags.map((t) => t.toLowerCase().trim());
  return STEEP.filter((s) => low.includes(s.toLowerCase()));
}

// Topical tag → domain branch. Deliberately conservative: an unmapped item gets NO
// branch rather than a guessed one, because a wrong branch is worse than a blank —
// it corrupts the branch counts that drive where scanning attention goes.
const BRANCH_RULES = [
  [/\b(robot|robotics|ai|automation|sensor|computer vision|tech|software|algorithm|data)\b/i, "Tech & AI"],
  [/\b(construction|prefab|prefabrication|modular|building material|factories|contractor|architecture|cement|concrete|steel)\b/i, "Construction"],
  [/\b(retail|store|mall|shop|merchand|grocery|commerce|multiuse|entertainment)\b/i, "Retail Industry"],
  [/\b(supply chain|logistics|freight|shipping|nearshoring|reshoring|warehouse|port|inventory)\b/i, "Supply Chain"],
  [/\b(labor|labour|workforce|staffing|gig economy|day labor|union|employment|hiring|wages)\b/i, "Labor & Operations"],
  [/\b(infrastructure|energy|grid|power|transit|rail|road|utility|water system|telecom)\b/i, "Infrastructure"],
  [/\b(real estate|property|housing|zoning|tariff|finance|investment|sovereign wealth|capital|insurance|tax|policy|regulation|geopolitics)\b/i, "Policy & Finance"],
  [/\b(climate|sustainab|emission|carbon|circular|resource scarcity|sand|materials? ?\/ ?resources|environment|waste|water)\b/i, "Sustainability & Environment"],
  [/\b(demograph|population|migration|aging|generation|community|social|culture|health|care)\b/i, "People & Human System"],
];

function branchesOf(tags) {
  // Tags only, deliberately. Matching the title as well was tested and produced false
  // positives — "aging cement plant" tripped the demographic rule via "aging" — and a
  // wrong branch is worse than a blank one because it corrupts the branch counts.
  // STEEP tags are excluded too: STEEP and Domain Branch are different axes, and letting
  // "Social" imply People & Human System conflates them.
  const steepLow = new Set(STEEP.map((x) => x.toLowerCase()));
  const hay = tags.filter((t) => !steepLow.has(t.toLowerCase().trim())).join(" ; ");
  const out = new Set();
  for (const [re, branch] of BRANCH_RULES) if (re.test(hay)) out.add(branch);
  return [...out];
}

const unescapeSlashes = (s) => String(s || "").replace(/\\\//g, "/");
const splitTags = (s) =>
  unescapeSlashes(s).split(",").map((t) => t.trim()).filter(Boolean);

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const stableId = (row) => row.id || createHash("sha1").update(row.url).digest("hex").slice(0, 24);

export function mapRow(row, collection = COLLECTION_DEFAULT) {
  const tags = splitTags(row.tags);
  const branches = branchesOf(tags);
  return {
    rid: stableId(row),
    title: trunc(row.title || row.url, 190),
    url: unescapeSlashes(row.url),
    domain: (() => { try { return new URL(unescapeSlashes(row.url)).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
    note: trunc(row.note, 1900),
    highlight: trunc(row.highlights || row.excerpt, 1900),
    tags: tags.slice(0, 25),
    horizon: horizonOf(tags),
    steep: steepOf(tags),
    branches: branches.length ? branches : [],
    captured: (row.created || "").slice(0, 10) || null,
    collection: row.folder ? row.folder.replace(/[,]/g, "") : collection,
  };
}

// ---------- Notion ----------
const api = async (path, method, body) => {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

const props = (m) => {
  const p = {
    Title: { title: [{ text: { content: m.title } }] },
    URL: { url: m.url },
    Domain: { rich_text: [{ text: { content: m.domain } }] },
    "Raindrop ID": { rich_text: [{ text: { content: m.rid } }] },
    Tags: { multi_select: m.tags.map((name) => ({ name })) },
    STEEP: { multi_select: m.steep.map((name) => ({ name })) },
    "Domain Branch": { multi_select: m.branches.map((name) => ({ name })) },
  };
  if (m.note) p.Note = { rich_text: [{ text: { content: m.note } }] };
  if (m.highlight) p.Highlight = { rich_text: [{ text: { content: m.highlight } }] };
  if (m.horizon) p.Horizon = { select: { name: m.horizon } };
  if (m.captured && /^\d{4}-\d{2}-\d{2}$/.test(m.captured)) p.Captured = { date: { start: m.captured } };
  if (m.collection) p.Collection = { select: { name: m.collection } };
  return p;
};

async function existingByRid() {
  const map = new Map();
  let cursor;
  do {
    const r = await api(`/databases/${DS_ID}/query`, "POST", { page_size: 100, start_cursor: cursor });
    for (const pg of r.results) {
      const rt = pg.properties?.["Raindrop ID"]?.rich_text?.[0]?.plain_text;
      if (rt) map.set(rt, pg.id);
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return map;
}

async function main() {
  if (!existsSync(CSV)) throw new Error(`CSV not found: ${CSV} — export it from Raindrop (Settings → Export → CSV) and commit it to the repo root.`);
  const rows = toObjects(parseCsv(readFileSync(CSV, "utf8")));
  const mapped = rows.map((r) => mapRow(r));
  // Same URL saved twice in Raindrop would otherwise create two rows.
  const byRid = new Map(mapped.map((m) => [m.rid, m]));
  console.log(`${rows.length} CSV rows → ${byRid.size} unique items`);
  const withH = [...byRid.values()].filter((m) => m.horizon).length;
  const withB = [...byRid.values()].filter((m) => m.branches.length).length;
  console.log(`  horizon mapped: ${withH}  domain-branch mapped: ${withB}`);
  if (DRY || !TOKEN || !DS_ID) {
    console.log(DRY ? "DRY_RUN — nothing written." : "NOTION_TOKEN / NOTION_REFERENCE_DB_ID missing — nothing written.");
    console.log(JSON.stringify([...byRid.values()].slice(0, 3), null, 1));
    return;
  }
  const existing = await existingByRid();
  let created = 0, updated = 0;
  for (const m of byRid.values()) {
    const pageId = existing.get(m.rid);
    if (pageId) { await api(`/pages/${pageId}`, "PATCH", { properties: props(m) }); updated++; }
    else { await api(`/pages`, "POST", { parent: { database_id: DS_ID }, properties: props(m) }); created++; }
    await new Promise((r) => setTimeout(r, 340)); // Notion ~3 req/s
  }
  console.log(`Reference Library: ${created} created, ${updated} updated.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
