# SitePulse

A daily web performance agent for GoElite's websites. Built by Ediomo Titus for the GoElite AI Agent Competition, Fall 2026.

## What it does (plain English)

Every morning (scheduled for 05:17 Lagos time; GitHub may start it later), SitePulse:

1. Reads the public sitemap of each GoElite site to get the current list of pages, so new pages are picked up automatically.
2. Chooses today's pages. Most pages are copies of a few templates (blogs, events, database entries), so it tests every one-off page and two samples of every template each day, and rotates through all other pages so **every page is tested at least once a week**.
3. Runs Google's PageSpeed test on each chosen page (mobile), staying under Google's limit of 30 tests a minute.
4. Compares each page with its usual result (the median of its last 3 results; a page needs at least 2 earlier results). Google's lab test swings a lot from day to day on the same page, so only big changes count: main content twice as slow and 2.5 s+ slower, script freezing 4x and 1.5 s+ longer, layout jumps up by 0.05+, a script from a source never seen before, or a page that usually passes now failing. Each suspect is tested twice more and alerts only if all three tests agree. Every alert explains the likely cause in plain English. Tests where the site's firewall showed Google a block page are recorded as "blocked", not as results. The rules are in `sites.json` under `alerts`.
5. Saves the results in `data/runs/` and posts to the SitePulse Lark group: the daily summary, any alerts, and on Mondays a weekly list of the slowest pages, pages that need a look (measured over 60 s, usually a late popup) and pages that couldn't be tested.

Coming next: matching each alert to the fixes that worked before, and a draft fix prepared with Claude for a human to approve. SitePulse never changes a live website by itself.

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
