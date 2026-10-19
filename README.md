# Signal Flow — an AI-augmented weak-signal scanning pipeline

A self-running weak-signal scanning system built for a strategic-foresight capstone on the future of the built environment. Three GitHub Actions scans run automatically, an AI pass drafts tentative reads under anti-consensus rules, and every candidate lands in a Notion database where all qualification judgment (Signal Strength, Tests Met, Decision-at-stake) stays human-held.

## How it runs

| Piece | Where | What it does |
|---|---|---|
| Repo (this one) | github.com/fikseforesight/signal-flow | Engines, feed configs, candidate archives |
| Compute | GitHub Actions (cron + manual) | Runs every scan and sync, no servers |
| Library | Notion — Signal Flow — Weak Signal Library | Where signals live and qualification happens |
| Review surface | index.html (GitHub Pages) | Lightweight queue view |

## Three scans, one shared engine

scan.mjs powers both the daily and wild scans; only the config differs.

Daily (daily-scan.yml + sources.json) is anchored to the nine-branch built-environment domain map: Labor & Operations, Supply Chain, Infrastructure, Construction, Retail Industry, Tech & AI, People & Human System, Policy & Finance, Sustainability & Environment.

Wild (wild-scan.yml + sources-wild.json) is deliberately domain-agnostic, twice weekly, reaching into terrain the daily scan never touches.

Substack (weekly-substack-scan.yml + substack-scan.mjs) is a separate engine with a rotating cursor over roughly 400 subscribed feeds.

Every candidate is de-duplicated (seen*.json), Claude drafts a tentative AI Read under anti-consensus rules (never down-rank for implausibility or fringeness), and sync-notion.yml pushes the result into Notion, tagging Scan Feed and Domain Branch along the way.

## Oct 2026 upgrades — critique, alerts, blind spots, digest

- **Critique pass.** After triage, every Weak signal / Wild card goes through a second, adversarial AI pass that tries to prove it is already known (six tests: named, codified, counted, mainstream, multiple instances, practitioner-named). 3+ "yes" → demoted to Trend. Writes `Critique`, `Weakness` (0–6 firm "no"s), `First?` and `Geography` to Notion. It can demote, never promote, never delete.
- **Faster review.** Notion sync now fires the moment a scan finishes. Each run's Summary page shows a ranked review queue. A GitHub issue (emailed) opens for strong candidates (credible firsts, wild cards, weakness 5–6).
- **Loud failures.** If the AI pass fails (e.g. API credits run out) the run turns red and an issue opens with the error. Raw items are still saved.
- **Weekly reports (Mondays).** `reports.mjs` writes `reports/digest-DATE.md` (top candidates, clusters, pressure on drivers, doubts) and `reports/blindspots-DATE.md` (thin branches and hunt zones, STEEP/horizon balance, source monoculture, geography), and emails both as one issue.
- **Scan fixes.** Domain Branch and Geography are now actually requested from the model (Domain Branch was never filled before). Horizon is judged on evidence (the old prompt told the model to bias toward H3). Feeders are interleaved before the raw-item cap so curated RSS isn't cut first. ArchDaily and sponsored posts are blocked. 17 feeds added for health, housing, community, CRE, payments, state policy, climate and Japan.
- **Sync speed.** Only the last 10 days of archive are re-checked; Run workflow → "full sync" re-checks everything.

## File layout

scan.mjs — daily + wild scan engine
substack-scan.mjs — substack scan engine with rotating cursor
sources.json — daily scan feed and query config
sources-wild.json — wild scan feed and query config
substack-feeds.txt — subscribed substack list
substack-cursor.json — rotation state for the substack scan
seen.json, seen-wild.json, substack-seen.json — de-dup memory per scan
push-to-notion.mjs — reads scan output, writes to Notion
alert.mjs — post-scan review queue + alert issues
reports.mjs, reports-config.json — weekly digest and blind-spot monitor
reports/ — weekly report archive
setup-notion.mjs — one-time Notion database schema creator
candidates.json, wild-candidates.json, substack-candidates.json — latest batch per scan, overwritten each run
archive/ — permanent record of every past batch
index.html — lightweight review queue on GitHub Pages
.github/workflows/ — the scheduled and manual Actions jobs

## One-time setup

Add repo secrets under Settings → Secrets and variables → Actions: ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID (and NOTION_PARENT_PAGE_ID only if re-running setup-notion.mjs to rebuild the schema from scratch).

Go to the Actions tab, open "Set up Notion database," and run it once. This creates the database and prints the id to paste into NOTION_DATABASE_ID.

Go to Settings → Pages, set source to "Deploy from a branch," pick main / (root), and save.

From the Actions tab, run Daily signal scan, Wild scan, or Weekly Substack scan manually to seed the library, or just wait for the schedule.

## Tuning

Daily scan brief, queries, and the domain map live in sources.json. Wild scan queries live in sources-wild.json. Curation rules (retrospective critique isn't a signal; r/Futurology needs cited evidence; anti-consensus discipline) live in the system prompts inside scan.mjs and substack-scan.mjs.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No new candidates for a day or two | Normal — de-dup means repeats don't return. Check Actions for red runs. |
| Anthropic API 401 | ANTHROPIC_API_KEY secret missing or revoked. |
| 429 or 529 errors | Rate-limited or overloaded; self-corrects next run. |
| Notion sync adds 0 new | Usually correct — everything already present (idempotent). |
| Feed looks stale | Hard-refresh (Cmd+Shift+R); CDN edges lag a few minutes after a commit. |

Full operational detail (schema notes, gotchas, planned Raindrop/Kumu integration) lives outside this repo in the project's operations doc.
