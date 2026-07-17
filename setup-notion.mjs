// Signal Flow — one-time Notion database creator.
// Run once (GitHub Action "Set up Notion database", workflow_dispatch).
// Requires secrets: NOTION_TOKEN, NOTION_PARENT_PAGE_ID (a Notion page shared with the integration).
// It creates the Signals database with the exact schema the sync script expects,
// then prints the new database id — paste that into the NOTION_DATABASE_ID secret.
// Native Node 20+, no dependencies.

const TOKEN = process.env.NOTION_TOKEN;
const PARENT = (process.env.NOTION_PARENT_PAGE_ID || "").replace(/-/g, "");
const NOTION_VERSION = "2022-06-28";

if (!TOKEN || !PARENT) {
  console.error("Missing NOTION_TOKEN or NOTION_PARENT_PAGE_ID. Add both as repo secrets.");
  process.exit(1);
}

const opt = (name, color = "default") => ({ name, color });

const properties = {
  "Signal": { title: {} },
  "Signal ID": { rich_text: {} },
  "What's changing": { rich_text: {} },
  "AI Read": { rich_text: {} },
  "Evidence": { rich_text: {} },
  "Classification": { select: { options: [
    opt("Weak signal", "purple"), opt("Wild card", "pink"), opt("Trend", "blue"),
    opt("Megatrend", "brown"), opt("Hype", "gray"),
  ] } },
  "Signal Strength": { select: { options: [
    opt("+3", "green"), opt("+2", "green"), opt("+1", "green"), opt("0", "gray"),
    opt("-1", "orange"), opt("-2", "red"), opt("-3", "red"),
  ] } },
  "Horizon": { select: { options: [opt("H1", "yellow"), opt("H2", "orange"), opt("H3", "red")] } },
  "STEEP-V Origin": { multi_select: { options: [
    opt("Social", "blue"), opt("Technological", "purple"), opt("Economic", "green"),
    opt("Environmental", "brown"), opt("Political", "red"), opt("Demographic", "orange"),
    opt("Values", "pink"),
  ] } },
  "SWIPES": { select: { options: [
    opt("Statistics"), opt("Writings"), opt("Innovations"), opt("Pitches"),
    opt("Entrants & exits"), opt("Superhits & outliers"),
  ] } },
  "Source": { rich_text: {} },
  "Source URL": { url: {} },
  "Scan Feed": { select: { options: [opt("daily", "blue"), opt("substack", "green"), opt("wild", "purple")] } },
  "Themes": { multi_select: {} },
  "Keywords": { multi_select: {} },
  "Date Found": { date: {} },
  "Status": { select: { options: [
    opt("Pending", "yellow"), opt("Core", "green"), opt("Context", "gray"), opt("Demoted", "red"),
  ] } },
  "Tests Met": { multi_select: { options: [opt("1"), opt("2"), opt("3"), opt("4"), opt("5")] } },
  "Decision-at-stake": { rich_text: {} },
  "Provenance": { select: { options: [opt("AI-suggested", "gray"), opt("Human-confirmed", "green")] } },
};

const res = await fetch("https://api.notion.com/v1/databases", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    parent: { type: "page_id", page_id: PARENT },
    title: [{ type: "text", text: { content: "Signal Flow — Weak Signal Library" } }],
    properties,
  }),
});

if (!res.ok) {
  console.error(`Notion API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}
const db = await res.json();
console.log("\n✅ Database created.");
console.log("   Title: Signal Flow — Weak Signal Library");
console.log(`\n>>> NOTION_DATABASE_ID = ${db.id}\n`);
console.log("Copy the id above into a new repo secret named NOTION_DATABASE_ID, then run the daily scan (or the Sync to Notion workflow).");
