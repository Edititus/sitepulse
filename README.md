# SitePulse

A daily web performance agent for GoElite's websites. Built by Ediomo Titus for the GoElite AI Agent Competition, Fall 2026.

## What it does (plain English)

Every morning, when the daily schedule is switched on (repository variable `SITEPULSE_SCHEDULE` = `on`; GitHub often starts scheduled runs hours late), SitePulse:

1. Reads the public sitemap of each GoElite site to get the current list of pages, so new pages are picked up automatically.
2. Chooses today's pages. Most pages are copies of a few templates (blogs, events, database entries), so it tests every one-off page and two samples of every template each day, and rotates through all other pages so **every page is tested at least once a week**.
3. Runs Google's PageSpeed test on each chosen page (mobile), staying under Google's limit of 30 tests a minute.
4. Compares each page with its last 5 results (a page needs at least 2). Google's lab test swings a lot, and many pages flip between a fast and a slow mode, so a page only alerts when it goes outside its normal range: main content slower than the slowest of its recent results by 25% and 1.5 s+, and at least twice its usual result (script freezing: 50% and 1 s+ above its range, 4x usual). Also: layout jumps up by 0.05+ beyond its range, a script or embed from a source never seen before, or a page that passed every recent test now failing. Each suspect is tested twice more and alerts only if all three tests agree. Limitations already reviewed and accepted (listed under `accepted` in `playbook.json`) don't alert unless the page changes. Tests where the site's firewall showed Google a block page are recorded as "blocked". The rules are in `sites.json` under `alerts`.
5. Saves the results in `data/runs/` and posts to the SitePulse Lark group: the daily summary, any alerts, and on Mondays a weekly list of the slowest pages, pages that need a look (measured over 60 s, usually a late popup) and pages that couldn't be tested.

6. Matches each alert to `playbook.json`, the fixes that worked on GoElite sites this fall. The alert names the closest past fix, what worked and what to watch out for, warns against things that were tried and failed, and flags known unfixed issues. Add new fixes to the file as you make them; no code change needed.

Coming next: a draft fix prepared with Claude for a human to approve. SitePulse never changes a live website by itself.

## Sites

Configured in `sites.json`: GoElite (GE), Day1CPT.org (ORG), Day1CPT Universities (D1CU), Day1CPT (D1CC), CPTDog (DOG), VeteranDegrees (VD). Chinese pages (`/zh/`) are skipped for now. Pages behind a login (student and B2B portals) are not tested.

"Pass" uses Google's "good" targets in the lab test: LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms. INP needs real visitors, so it comes from Google's field data when a page has enough traffic.

## Running it by hand

GitHub → **Actions** → **SitePulse daily check** → **Run workflow**, then pick:

- **mode**: `dry-run` (list pages only, no tests), `daily` (today's selection) or `full` (every page, about 2 hours)
- **site**: e.g. `D1CU`, or blank for all
- **limit**: max pages per site, e.g. `5` for a quick test
- **weekly**: tick to also send the weekly list now (it goes out automatically on Mondays)

## Secrets (Settings → Secrets and variables → Actions)

- `PAGESPEED_API_KEY`: Google API key restricted to PageSpeed Insights and Chrome UX Report
- `LARK_WEBHOOK_URL`: webhook of the SitePulse Lark bot (keyword: `SitePulse`)

Never put either value in a file in this repository.

## Developing

Requires Node 22.18 or later (runs TypeScript directly, no build step).

```
npm install          # only for type checking
npm test             # unit tests
npm run typecheck
npm run dry-run      # needs internet access to the sitemaps
```

`test/fixtures/lighthouse.json` is a trimmed Lighthouse 13 report generated locally against a test page, used to check that results are read correctly.
