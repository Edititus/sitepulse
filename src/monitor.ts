// SitePulse daily check: read sitemaps, choose today's pages, test them, save the
// results and send a summary to Lark.
//
// Usage:
//   node src/monitor.ts                      # today's daily selection, all sites
//   node src/monitor.ts --site D1CU --limit 5
//   node src/monitor.ts --mode full          # every page (slow, ~2 hours)
//   node src/monitor.ts --mode dry-run       # list pages only, no tests
//
// Needs PAGESPEED_API_KEY (except dry-run). LARK_WEBHOOK_URL is optional.

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, type Strategy } from "./config.ts";
import { applyExcludes, dayNumberUtc, fetchSitemapUrls, selectPages, type Selected } from "./pages.ts";
import { RateLimiter, runTest } from "./psi.ts";
import { sendText } from "./lark.ts";
import { buildMessage, passes, type ResultRow } from "./report.ts";

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "daily" }, // daily | full | dry-run
    site: { type: "string", default: "" }, // e.g. "D1CU" or "D1CU,VD"
    limit: { type: "string", default: "0" }, // max pages per site, 0 = no limit
    strategy: { type: "string", default: "" }, // overrides sites.json, e.g. "mobile"
    notify: { type: "string", default: "true" },
    config: { type: "string", default: "sites.json" },
  },
});

const mode = args.mode as "daily" | "full" | "dry-run";
if (!["daily", "full", "dry-run"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const notify = args.notify !== "false";
const limit = Math.max(0, parseInt(args.limit!, 10) || 0);
const config = loadConfig(args.config);
const wanted = args.site ? args.site.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
const sites = wanted.length ? config.sites.filter((s) => wanted.includes(s.code)) : config.sites;
if (!sites.length) throw new Error(`No site matches "${args.site}". Codes: ${config.sites.map((s) => s.code).join(", ")}`);
const strategies = (args.strategy ? args.strategy.split(",") : config.strategies) as Strategy[];

const apiKey = process.env.PAGESPEED_API_KEY ?? "";
const webhook = process.env.LARK_WEBHOOK_URL ?? "";
if (mode !== "dry-run" && !apiKey) throw new Error("PAGESPEED_API_KEY is not set");

const started = new Date();
const runId = started.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const dayNumber = dayNumberUtc(started);
const runLink = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

// 1. Page lists.
const plan: Array<Selected & { site: string }> = [];
const sitemapErrors: Record<string, string> = {};
for (const site of sites) {
  try {
    const all = applyExcludes(await fetchSitemapUrls(site.sitemap), site.exclude);
    let chosen = selectPages(all, {
      dayNumber,
      rotationDays: config.rotation_days,
      samplesPerTemplate: config.samples_per_template,
      templateMinPages: config.template_min_pages,
      mode: mode === "full" ? "full" : "daily",
    });
    if (limit) chosen = chosen.slice(0, limit);
    const byReason = chosen.reduce<Record<string, number>>((a, c) => ((a[c.reason] = (a[c.reason] ?? 0) + 1), a), {});
    console.log(`${site.code}: ${all.length} pages in sitemap, ${chosen.length} chosen ${JSON.stringify(byReason)}`);
    plan.push(...chosen.map((c) => ({ ...c, site: site.code })));
  } catch (e) {
    sitemapErrors[site.code] = (e as Error).message.slice(0, 120);
    console.error(`${site.code}: sitemap error: ${sitemapErrors[site.code]}`);
  }
}
const totalTests = plan.length * strategies.length;
console.log(`Total: ${plan.length} pages x ${strategies.length} strategy = ${totalTests} tests, ` +
  `about ${Math.ceil(totalTests / config.rate_per_minute)} min at ${config.rate_per_minute}/min`);

if (mode === "dry-run") {
  if (notify && webhook) {
    const lines = [`SitePulse dry run (no tests): would test ${plan.length} pages today.`];
    for (const s of sites) {
      lines.push(sitemapErrors[s.code] ? `${s.code}: sitemap error (${sitemapErrors[s.code]})`
        : `${s.code}: ${plan.filter((p) => p.site === s.code).length} pages`);
    }
    await sendText(webhook, lines.join("\n"));
    console.log("Sent dry-run message to Lark.");
  }
  process.exit(Object.keys(sitemapErrors).length === sites.length ? 1 : 0);
}

// 2. Run the tests, a few at a time, never faster than the rate limit.
const limiter = new RateLimiter(config.rate_per_minute);
const rows: ResultRow[] = [];
const jobs = plan.flatMap((p) => strategies.map((strategy) => ({ ...p, strategy })));
let next = 0;
let done = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const { summary, error } = await runTest(job.url, apiKey, job.strategy, limiter);
    rows.push({
      run_id: runId,
      site: job.site,
      url: job.url,
      reason: job.reason,
      strategy: job.strategy,
      error,
      ...(summary ?? {}),
      pass: summary ? passes(summary, config.thresholds) : null,
    });
    done++;
    if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} tested`);
  }
}
await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, worker));

// 3. Save results (committed back to the repo by the workflow).
mkdirSync("data/runs", { recursive: true });
rows.sort((a, b) => a.site.localeCompare(b.site) || a.url.localeCompare(b.url));
writeFileSync(`data/runs/${runId}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const minutes = Math.max(1, Math.round((Date.now() - started.getTime()) / 60_000));
const message = buildMessage({
  dateLabel: started.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }),
  strategy: strategies.join("+"),
  minutes,
  rows,
  siteCodes: sites.map((s) => s.code),
  sitemapErrors,
  runLink,
  thresholds: config.thresholds,
});
writeFileSync(`data/runs/${runId}-summary.txt`, message + "\n");
console.log("\n" + message);

// 4. Tell Lark.
if (notify && webhook) {
  await sendText(webhook, message);
  console.log("Sent summary to Lark.");
}
const failed = rows.filter((r) => r.error).length;
if (rows.length && failed === rows.length) {
  console.error("Every test failed. Check the API key and quota.");
  process.exit(1);
}
