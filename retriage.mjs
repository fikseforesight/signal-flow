// Signal Flow — re-triage items that reached Notion UNTRIAGED during an AI outage (Oct 3-26, 2026:
// the API ran out of credits and the scan saved raw feed items instead of losing the day).
//   node retriage.mjs fetch <daily|wild>  → raw-retriage-<feed>.json   (pages still Pending + raw)
//   (scan.mjs then runs with RAW_INPUT_FILE pointing at that file — triage + critique)
//   node retriage.mjs apply <daily|wild>  → writes results back onto the SAME Notion pages
// Pages the AI selected get full triage fields; pages it did not select are set to Status
// "Demoted" with a note (reversible — nothing is deleted). Only touches pages that are still
// Pending AND still carry the raw-item marker, so anything Kristen has edited is left alone.
// Env: NOTION_TOKEN, NOTION_DATABASE_ID, NO_AUTORUN=1 (required, so the sync doesn't run on import).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildProps, buildBody, ensureSchema, notion, normUrl } from "./push-to-notion.mjs";
import { critiquePass } from "./critique.mjs";

const [mode, feed] = process.argv.slice(2);
const DB = process.env.NOTION_DATABASE_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (p) => !p ? "" : p.title ? p.title.map((t) => t.plain_text).join("") : p.rich_text ? p.rich_text.map((t) => t.plain_text).join("") : p.select ? (p.select?.name || "") : p.url || (p.date?.start || "");
const RAW_FILE = `raw-retriage-${feed}.json`;
const OUT_FILE = `retriage-${feed}-candidates.json`;
const rawFilter = (f) => ({ and: [
  { property: "Scan Feed", select: { equals: f } },
  { property: "Status", select: { equals: "Pending" } },
  { or: [{ property: "AI Read", rich_text: { contains: "AI pass failed" } }, { property: "AI Read", rich_text: { contains: "no AI pass" } }] },
] });

async function fetchRaw() {
  const out = []; let cursor;
  do {
    const j = await notion(`/databases/${DB}/query`, "POST", { filter: rawFilter(feed), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of j.results) {
      const P = p.properties;
      out.push({ page_id: p.id, title: txt(P["Signal"]), url: txt(P["Source URL"]), snippet: txt(P["Evidence"]).slice(0, 300), source: txt(P["Source"]), date: txt(P["Date Published"]), feeder: txt(P["Source Type"]) || "rss" });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  writeFileSync(RAW_FILE, JSON.stringify(out));
  console.log(`${feed}: ${out.length} raw pages exported → ${RAW_FILE}`);
}

async function apply() {
  if (!existsSync(OUT_FILE)) { console.error(`${OUT_FILE} missing — scan did not run`); process.exit(1); }
  const status = JSON.parse(readFileSync("scan-status.json", "utf8"));
  const raw = JSON.parse(readFileSync(RAW_FILE, "utf8"));
  const cands = JSON.parse(readFileSync(OUT_FILE, "utf8")).candidates || [];
  if (status.ai === "failed" || status.ai === "no-key") { console.error(`AI pass ${status.ai}: ${status.error} — nothing written to Notion.`); process.exit(1); }
  await ensureSchema();
  const pagesByUrl = new Map();
  for (const r of raw) { const k = normUrl(r.url); if (!pagesByUrl.has(k)) pagesByUrl.set(k, []); pagesByUrl.get(k).push(r.page_id); }
  const used = new Set();
  let updated = 0, demoted = 0, unmatched = 0, failed = 0;
  for (const c of cands) {
    const pid = c.page_id || (pagesByUrl.get(normUrl(c.url)) || []).find((p) => !used.has(p));
    if (!pid || used.has(pid)) { unmatched++; continue; }
    used.add(pid);
    try {
      const props = buildProps(c, feed);
      delete props["Signal ID"]; delete props["Scan Feed"];
      await notion(`/pages/${pid}`, "PATCH", { properties: props });
      const kids = buildBody(c);
      if (kids.length) await notion(`/blocks/${pid}/children`, "PATCH", { children: [{ object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "Re-triaged 2026-10-26" } }] } }, ...kids].slice(0, 90) });
      updated++;
    } catch (e) { failed++; console.error(`  ! ${c.title?.slice(0, 50)}: ${e.message}`); }
    await sleep(350);
  }
  // Only demote unselected pages when every AI batch ran — a failed batch would otherwise
  // look like "not selected".
  if (status.ai === "ok") {
    for (const r of raw) {
      if (used.has(r.page_id)) continue;
      try {
        await notion(`/pages/${r.page_id}`, "PATCH", { properties: {
          "Status": { select: { name: "Demoted" } },
          "AI Read": { rich_text: [{ type: "text", text: { content: "(Re-triage 2026-10-26: not selected by the AI pass — low built-environment relevance, duplicate, or retrospective. Set Status back to Pending to reconsider.)" } }] },
        } });
        demoted++;
      } catch (e) { failed++; console.error(`  ! demote ${r.page_id}: ${e.message}`); }
      await sleep(350);
    }
  } else console.log(`AI pass was "${status.ai}" — leaving unselected pages Pending.`);
  const kept = cands.filter((c) => c.classification === "Weak signal" || c.classification === "Wild card").length;
  console.log(`\n${feed} re-triage: ${raw.length} raw → ${cands.length} candidates (${kept} weak/wild survivors). Notion: ${updated} pages updated, ${demoted} set to Demoted, ${unmatched} candidates unmatched${failed ? `, ${failed} failed` : ""}. Critique: ${JSON.stringify(status.critique)}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${feed} re-triage\n${raw.length} raw → ${cands.length} candidates, ${kept} weak/wild. ${updated} updated, ${demoted} demoted, ${failed} failed.\n`, { flag: "a" });
  if (failed) process.exitCode = 1;
}

// CRITIQUE-ONLY MODE: run the critique pass over Pending weak signals / wild cards that never got
// one (e.g. v1 of the pass silently skipped most items). Writes Critique, Weakness, First?; demotes
// to Trend + Status Demoted where 3+ tests say it's already known. Never touches Core/Context.
//   node retriage.mjs critique <since YYYY-MM-DD>
async function critiqueOnly(since) {
  const cfg = JSON.parse(readFileSync("sources.json", "utf8")).config;
  await ensureSchema();
  const rows = []; let cursor;
  do {
    const j = await notion(`/databases/${DB}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), filter: { and: [
      { property: "Status", select: { equals: "Pending" } },
      { or: [{ property: "Classification", select: { equals: "Weak signal" } }, { property: "Classification", select: { equals: "Wild card" } }] },
      { property: "Critique", rich_text: { is_empty: true } },
      { timestamp: "created_time", created_time: { on_or_after: since } },
    ] } });
    for (const p of j.results) { const P = p.properties; rows.push({ page_id: p.id, title: txt(P["Signal"]), shift: txt(P["What's changing"]), evidence: txt(P["Evidence"]).slice(0, 400), source: txt(P["Source"]), date: txt(P["Date Published"]), classification: txt(P["Classification"]), ai_read: txt(P["AI Read"]) }); }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  console.log(`${rows.length} uncritiqued Pending weak signals / wild cards since ${since}`);
  const stats = await critiquePass(rows, { apiKey: process.env.ANTHROPIC_API_KEY, model: cfg.critiqueModel || cfg.model });
  let written = 0, failed = 0;
  for (const c of rows.filter((r) => r.critique)) {
    const props = { "Critique": { rich_text: [{ type: "text", text: { content: c.critique.slice(0, 1990) } }] }, "Weakness": { number: c.weakness } };
    if (["yes", "plausible", "no"].includes(String(c.first_claim).toLowerCase())) props["First?"] = { select: { name: String(c.first_claim).toLowerCase() } };
    if (c.original_classification) {
      props["Classification"] = { select: { name: "Trend" } };
      props["Status"] = { select: { name: "Demoted" } };
      props["AI Read"] = { rich_text: [{ type: "text", text: { content: c.ai_read.slice(0, 1990) } }] };
    }
    try { await notion(`/pages/${c.page_id}`, "PATCH", { properties: props }); written++; }
    catch (e) { failed++; console.error(`  ! ${c.title.slice(0, 50)}: ${e.message}`); }
    await sleep(350);
  }
  const msg = `Critique-only: ${rows.length} items, ${stats.checked} critiqued, ${stats.demoted} demoted to Trend, ${stats.missing} no verdict; ${written} pages written${failed ? `, ${failed} failed` : ""}.`;
  console.log(msg);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${msg}\n`, { flag: "a" });
  if (failed) process.exitCode = 1;
}

if (mode === "critique") await critiqueOnly(feed || "2026-10-01");
else if (mode === "fetch") await fetchRaw();
else if (mode === "apply") await apply();
else { console.error("usage: node retriage.mjs fetch|apply daily|wild"); process.exit(1); }
