# SitePulse

A daily web performance agent for GoElite's websites. Built by Ediomo Titus for the GoElite AI Agent Competition, Fall 2026.

## What it does (plain English)

Every morning at 06:00 Lagos time, SitePulse:

1. Reads the public sitemap of each GoElite site to get the current list of pages, so new pages are picked up automatically.
2. Chooses today's pages. Most pages are copies of a few templates (blogs, events, database entries), so it tests every one-off page and two samples of every template each day, and rotates through all other pages so **every page is tested at least once a week**.
3. Runs Google's PageSpeed test on each chosen page (mobile), staying under Google's limit of 30 tests a minute.
4. Saves the results in `data/runs/` and posts a summary to the SitePulse Lark group.

Coming next: alerts only when a page drops below target on two runs in a row, the likely cause, and a draft fix prepared with Claude for a human to approve. SitePulse never changes a live website by itself.

## Sites

Configured in `sites.json`: GoElite (GE), Day1CPT.org (ORG), Day1CPT Universities (D1CU), Day1CPT (D1CC), CPTDog (DOG), VeteranDegrees (VD). Chinese pages (`/zh/`) are skipped for now. Pages behind a login (student and B2B portals) are not tested.

"Pass" uses Google's "good" targets in the lab test: LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms. INP needs real visitors, so it comes from Google's field data when a page has enough traffic.

## Running it by hand

GitHub → **Actions** → **SitePulse daily check** → **Run workflow**, then pick:

- **mode**: `dry-run` (list pages only, no tests), `daily` (today's selection) or `full` (every page, about 2 hours)
- **site**: e.g. `D1CU`, or blank for all
- **limit**: max pages per site, e.g. `5` for a quick test

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
