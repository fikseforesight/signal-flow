# Signal Flow — web edition

A self-feeding weak-signal scanning tool. The app is a single HTML page hosted on GitHub Pages; a GitHub Actions job runs every morning, pulls feeds across the built-environment domain map (GDELT, arXiv, OpenAlex, Hacker News, trade RSS), de-dupes against everything already seen, has Claude draft tentative reads under anti-consensus rules, and commits a fresh `candidates.json`. When you open the page, new candidates flow into your review queue automatically. You hold all qualification judgment.

## Layout (flat, so browser upload is easy)

```
index.html        the app (GitHub Pages serves this)
candidates.json   latest scan batch (the app auto-loads this)
seen.json         normalized URLs already processed (de-dup memory)
archive/          every daily batch (created by the scan job)
scan.mjs          the daily scan engine
sources.json      feeder registry + config (edit this one)
.github/workflows/daily-scan.yml   the daily schedule
```

## One-time setup

1. Create a **public** repo named `signal-flow` on github.com.
2. Upload `index.html`, `candidates.json`, `seen.json`, `scan.mjs`, `sources.json`, `README.md` to the repo root.
3. Create `.github/workflows/daily-scan.yml` via Add file → Create new file (type the path with slashes), paste the workflow contents.
4. Settings → Pages → Deploy from a branch → `main` / `(root)` → Save. App goes live at `https://<username>.github.io/signal-flow/`.
5. Settings → Secrets and variables → Actions → New repository secret: `ANTHROPIC_API_KEY` = your key from console.anthropic.com.
6. Actions tab → Daily signal scan → Run workflow. Green run = fresh candidates on your next page load.

## Moving your existing library in

Your local `signal-flow.html` library lives in that browser's storage and doesn't transfer automatically. In the local file: **Backup (JSON)**. On the web app: **Import → Restore from backup**. Do this once; afterwards use only the web app.

## What's public / what's private

The repo (queries, scan code, daily candidate files) is public. **Your library — qualifications, decisions-at-stake, impact ratings — is not in the repo.** It lives only in your browser's localStorage. Keep taking JSON backups (they're your only copy). If you want the library itself synced across devices later, that's the Supabase build.

## Tuning the scan

Everything editable lives in `sources.json`: the standing hunt queries per feeder (`gdeltQueries`, `arxivQueries`, `openalexQueries`, `hnQueries`), the `rssFeeds` list, the `relevanceKeywords` gate, `config.model` / `config.maxCandidates`, and `domainMap` (the scan's standing brief). The anti-consensus rules live in the system prompt inside `scan.mjs` — the AI never drops items for implausibility, never assigns impact (human-held), and labels every read tentative.

## Troubleshooting

- **No new candidates for a day or two** — normal; de-dup means repeats don't come back. Check the Actions tab for red runs.
- **Action fails with `Anthropic API 401`** — the secret is missing or the key was revoked; re-add it.
- **Action fails with `429/529`** — rate-limited or overloaded; it self-corrects on tomorrow's run.
- **Feed looks stale** — hard-refresh (Cmd+Shift+R); CDN edges can lag a few minutes after a commit.
- **Weekly deep scans** — keep doing these in Cowork ("run a deep scan off my domain map"); import the JSON via **Import → Merge AI scan candidates**. The cron gives breadth; sessions give the strange stuff.
