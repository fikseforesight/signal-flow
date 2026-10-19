// Signal Flow — weekly foresight reports (Mondays). Reads the Notion library; writes two
// markdown reports to reports/ and opens one GitHub issue so they arrive by email.
//  1. BLIND-SPOT MONITOR (last 30 days, no AI): what the scans are NOT seeing — thin domain
//     branches and hunt zones, STEEP and horizon balance, source monoculture, geography.
//  2. FORESIGHT DIGEST (last 7 days): the week's strongest unqualified candidates — firsts, weakest,
//     wild cards — loose clusters, and which of Kristen's drivers they press on. One AI call;
//     if the AI is unavailable the digest still ships as a ranked list.
// Env: NOTION_TOKEN, NOTION_DATABASE_ID, ANTHROPIC_API_KEY (optional), GITHUB_TOKEN, GITHUB_REPOSITORY.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CFG = JSON.parse(readFileSync("reports-config.json", "utf8"));
const { NOTION_TOKEN: TOKEN, NOTION_DATABASE_ID: DB, ANTHROPIC_API_KEY: KEY } = process.env;
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notion(path, method, body) {
  const res = await fetch("https://api.notion.com/v1" + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) { await sleep(1500); return notion(path, method, body); }
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const txt = (p) => !p ? "" : p.title ? p.title.map((t) => t.plain_text).join("") : p.rich_text ? p.rich_text.map((t) => t.plain_text).join("") : p.select ? (p.select?.name || "") : p.multi_select ? p.multi_select.map((o) => o.name).join(" / ") : p.url ? p.url : p.number != null ? String(p.number) : "";

async function pages(sinceDays) {
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const out = []; let cursor;
  do {
    const j = await notion(`/databases/${DB}/query`, "POST", { filter: { timestamp: "created_time", created_time: { on_or_after: since } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of j.results) {
      const P = p.properties, g = (k) => txt(P[k]);
      out.push({ title: g("Signal"), shift: g("What's changing"), cls: g("Classification"), status: g("Status"), horizon: g("Horizon"), steep: g("STEEP-V Origin"), branch: g("Domain Branch"), source: g("Source"), url: g("Source URL"), feed: g("Scan Feed"), novelty: g("Novelty"), critique: g("Critique"), weakness: P.Weakness?.number ?? null, first: g("First?"), geo: g("Geography"), created: p.created_time.slice(0, 10), link: p.url });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0) + "%";
const count = (arr, f) => { const m = new Map(); for (const x of arr) for (const k of [].concat(f(x)).filter(Boolean)) m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

// ---------- 1. blind spots ----------
const month = await pages(30);
const live = month.filter((x) => x.status !== "Demoted");
let B = `# Blind-spot monitor — ${today}\n\n_Last 30 days: ${month.length} items synced, ${live.length} not demoted. Counts are of what the scans SAW, not what matters — the point is to notice what they don't see._\n\n`;
const branchCounts = new Map(count(live, (x) => x.branch.split(" / ")));
const untagged = live.filter((x) => !x.branch).length;
B += `## Domain-map branches\n\n| Branch | Items | Share |\n|---|---|---|\n`;
const thin = [];
for (const b of CFG.branches) { const n = branchCounts.get(b) || 0; B += `| ${b} | ${n} | ${pct(n, live.length)} |\n`; if (n < live.length * 0.05) thin.push(b); }
B += `| Off-map | ${branchCounts.get("Off-map / Not Built-Environment") || 0} | |\n| (no branch tagged) | ${untagged} | ${pct(untagged, live.length)} |\n\n`;
if (untagged > live.length * 0.5) B += `> Most items have no branch yet — branch tagging only started Oct 2026, so this table fills in over the coming weeks.\n\n`;
B += `## Hunt zones (keyword count in title + shift)\n\n`;
for (const [zone, kws] of Object.entries(CFG.huntZones)) {
  const n = live.filter((x) => kws.some((k) => (x.title + " " + x.shift).toLowerCase().includes(k))).length;
  B += `- **${zone}:** ${n} (${pct(n, live.length)})${n < live.length * 0.04 ? " ← thin" : ""}\n`;
  if (n < live.length * 0.04) thin.push(zone);
}
const steep = count(live, (x) => x.steep.split(" / "));
B += `\n## STEEP-V balance\n\n${steep.map(([k, n]) => `- ${k}: ${n} (${pct(n, live.length)})`).join("\n")}\n`;
const missingSteep = ["Social", "Technological", "Economic", "Environmental", "Political", "Demographic", "Values"].filter((s) => !steep.find(([k]) => k === s) || steep.find(([k]) => k === s)[1] < live.length * 0.04);
if (missingSteep.length) B += `\n**Under-represented:** ${missingSteep.join(", ")}\n`;
const hz = count(live, (x) => x.horizon || "none");
B += `\n## Horizon balance\n\n${hz.map(([k, n]) => `- ${k}: ${n} (${pct(n, live.length)})`).join("\n")}\n`;
const h3 = (hz.find(([k]) => k === "H3") || [0, 0])[1];
if (h3 > live.length * 0.45) B += `\n> H3 is ${pct(h3, live.length)} of the live library. That is high for a scan of current news: check whether strangeness is being read as distance.\n`;
const src = count(live, (x) => x.source);
const top3 = src.slice(0, 3).reduce((a, [, n]) => a + n, 0);
B += `\n## Source concentration\n\nTop 3 sources = **${pct(top3, live.length)}** of items${top3 > live.length * 0.3 ? " ← monoculture risk: one editorial lens is shaping the library" : ""}.\n\n${src.slice(0, 10).map(([k, n]) => `- ${k}: ${n}`).join("\n")}\n`;
const geo = count(live.filter((x) => x.geo), (x) => x.geo);
B += `\n## Geography\n\n${geo.length ? geo.slice(0, 12).map(([k, n]) => `- ${k}: ${n}`).join("\n") : "_Geography tagging started Oct 2026 — no data yet._"}\n`;
const usShare = geo.filter(([k]) => /^us|united states|america/i.test(k)).reduce((a, [, n]) => a + n, 0);
if (geo.length && usShare > geo.reduce((a, [, n]) => a + n, 0) * 0.5) B += `\n> Over half of geo-tagged items are US. The domain map asks for the periphery (Gulf, Africa, South & Southeast Asia, Latin America) — it is not being reached.\n`;
B += `\n## Suggested fixes\n\n${[...new Set(thin)].map((t) => `- **${t}** is thin → consider: ${(CFG.feedIdeas[t] || ["(add a source)"]).join(", ")}`).join("\n") || "- No thin areas this month."}\n- **Geography:** ${CFG.feedIdeas.Geography.join(", ")}\n`;

// ---------- 2. digest ----------
const week = month.filter((x) => x.created >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
const pool = week.filter((x) => x.status !== "Demoted" && /Weak signal|Wild card/.test(x.cls));
const rank = (x) => (x.first === "yes" ? 3 : x.first === "plausible" ? 1.5 : 0) + (x.cls === "Wild card" ? 1.5 : 0) + (x.weakness != null ? x.weakness / 2 : 0) + (x.novelty === "High" ? 1 : 0);
pool.sort((a, b) => rank(b) - rank(a));
const top = pool.slice(0, 40);
let D = `# Weekly foresight digest — ${today}\n\n_${week.length} items synced this week; ${pool.length} survived as weak signals or wild cards. All are AI-suggested and unqualified._\n\n`;
let aiText = "";
if (KEY && top.length) {
  try {
    const sys = `You write a weekly strategic-foresight digest for Kristen, a foresight lead studying how external forces reshape a mass-market retailer's physical stores and real estate. Be skeptical and plain-spoken. Never call something a weak signal just because it is strange; weakness means little-known. Never invent facts beyond the items given. Headlines factual; put provocations on a separate line starting "What if".
Her drivers: ${CFG.drivers.join("; ")}.
Write markdown with these sections:
## The 5 to watch — the strongest candidates (prefer credible firsts and the least-known), one short paragraph each: what happened, why it may be weak/first, which driver it presses on, then a "What if" line. Link each with its URL.
## Clusters — 2-4 loose groupings where several items point the same way; name the shift in plain words; say if a cluster looks like a weak signal strengthening toward a trend.
## Pressure on the drivers — for each driver touched this week, one line: reinforced, challenged, or a new angle. Flag any item that fits NO driver (possible missing driver).
## Doubts — 2-4 items that look stronger than they are (single source, title overstates, already a known trend), and why.
## One question for this week — a single question that would change a store or real-estate decision.
Under 700 words.`;
    const user = top.map((x, i) => `${i + 1}. ${x.title} | ${x.cls} | ${x.horizon} | first:${x.first || "?"} | weakness:${x.weakness ?? "?"} | ${x.branch} | ${x.geo}\n   shift: ${x.shift}\n   critique: ${x.critique}\n   ${x.url}`).join("\n");
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: CFG.model, max_tokens: 4000, system: sys, messages: [{ role: "user", content: user }] }) });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    aiText = ((await res.json()).content || []).map((b) => b.text || "").join("");
  } catch (e) { D += `> AI digest unavailable (${e.message.slice(0, 160)}). Ranked list only.\n\n`; }
}
D += aiText ? aiText + "\n\n" : "";
D += `## Full ranked list (top ${top.length})\n\n${top.map((x) => `- **${x.title}** — ${x.cls} · ${x.horizon || "?"}${x.first === "yes" ? " · FIRST?" : ""}${x.weakness != null ? ` · weakness ${x.weakness}/6` : ""} · [source](${x.url}) · [Notion](${x.link})`).join("\n") || "_none this week_"}\n`;

mkdirSync("reports", { recursive: true });
writeFileSync(`reports/blindspots-${today}.md`, B);
writeFileSync(`reports/digest-${today}.md`, D);
console.log(D + "\n\n" + B);

const { GITHUB_TOKEN: t, GITHUB_REPOSITORY: repo } = process.env;
if (t && repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: "POST", headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "content-type": "application/json" }, body: JSON.stringify({ title: `Weekly foresight digest + blind spots — ${today}`, body: (D + "\n\n---\n\n" + B).slice(0, 64000), labels: ["weekly-digest"] }) });
  console.log("issue:", res.status);
}
