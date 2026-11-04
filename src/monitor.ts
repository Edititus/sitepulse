// SitePulse daily check: read sitemaps, choose today's pages, test them, compare
// each page with its own last result, confirm anything that got worse with a
// second test, save the results and tell Lark (summary + alerts + weekly list).
//
// Usage:
//   node src/monitor.ts                      # today's daily selection, all sites
//   node src/monitor.ts --site D1CU --limit 5
//   node src/monitor.ts --mode full          # every page (slow, ~2 hours)
//   node src/monitor.ts --mode dry-run       # list pages only, no tests
//   node src/monitor.ts --weekly true        # also send the weekly list today
//
// Needs PAGESPEED_API_KEY (except dry-run). LARK_WEBHOOK_URL is optional.

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, type Strategy } from "./config.ts";
import { applyExcludes, dayNumberUtc, fetchSitemapUrls, selectPages, type Selected } from "./pages.ts";
import { RateLimiter, runTest } from "./psi.ts";
import { sendText } from "./lark.ts";
import { buildMessage, passes, type ResultRow } from "./report.ts";
import { keyOf, recentByPage, runFiles } from "./history.ts";
import {
  DEFAULT_RULES, buildAlertMessage, buildBaseline, confirm, detect, explainCauses, templateKey,
  type Alert, type AlertRules, type Detection,
} from "./alerts.ts";
import { buildWeekly, latestIncludingErrors } from "./weekly.ts";
import { minutesThisMonth } from "./github.ts";

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "daily" }, // daily | full | dry-run
    site: { type: "string", default: "" }, // e.g. "D1CU" or "D1CU,VD"
    limit: { type: "string", default: "0" }, // max pages per site, 0 = no limit
    strategy: { type: "string", default: "" }, // overrides sites.json, e.g. "mobile"
    notify: { type: "string", default: "true" },
    config: { type: "string", default: "sites.json" },
    weekly: { type: "string", default: "auto" }, // auto = Mondays (Lagos) | true | false
    "max-retests": { type: "string", default: "" }, // overrides alerts.max_suspects
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

function toRow(job: { site: string; url: string; reason: Selected["reason"]; strategy: Strategy }, r: Awaited<ReturnType<typeof runTest>>): ResultRow {
  return {
    run_id: runId,
    site: job.site,
    url: job.url,
    reason: job.reason,
    strategy: job.strategy,
    error: r.error,
    ...(r.summary ?? {}),
    pass: r.summary ? passes(r.summary, config.thresholds) : null,
  };
}

async function runPool<T>(items: T[], work: (item: T) => Promise<void>) {
  let next = 0;
  const workerFn = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, items.length) }, workerFn));
}

let done = 0;
await runPool(jobs, async (job) => {
  rows.push(toRow(job, await runTest(job.url, apiKey, job.strategy, limiter)));
  done++;
  if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} tested`);
});

// 3. Compare each page with its usual result (median of its last few results).
//    Anything that looks clearly worse is tested twice more and only alerts if all three tests agree.
const RUNS_DIR = "data/runs";
const rules: AlertRules = { ...DEFAULT_RULES, ...(config.alerts ?? {}) };
const history = recentByPage(runFiles(RUNS_DIR, started, 30, runId), rules.history_size);
const baselines = new Map<string, ResultRow>();
const suspects: Array<{ index: number; first: Detection; jump: number }> = [];
rows.forEach((row, index) => {
  const base = buildBaseline(history.get(keyOf(row)), rules);
  if (!base) return;
  baselines.set(keyOf(row), base);
  const first = detect(row, base, config.thresholds, rules);
  if (first.kinds.length) suspects.push({ index, first, jump: (row.lab?.lcp_ms ?? 0) / (base.lab?.lcp_ms || 1) });
});
// Biggest jumps first, so the retest budget goes to the most likely real problems.
suspects.sort((x, y) => y.jump - x.jump);
const maxSuspects = Math.max(0, parseInt(args["max-retests"]!, 10) || config.alerts?.max_suspects || 30);
const toRetest = suspects.slice(0, maxSuspects);
console.log(`${baselines.size} pages have enough history to compare. ${suspects.length} look worse; re-testing ${toRetest.length} twice each.`);

const alerts: Alert[] = [];
let unconfirmed = suspects.length - toRetest.length;
await runPool(toRetest, async ({ index, first }) => {
  const row = rows[index];
  const base = baselines.get(keyOf(row))!;
  const job = { ...row, strategy: row.strategy as Strategy };
  const extra: ResultRow[] = [];
  for (let i = 0; i < 2; i++) {
    const r = toRow(job, await runTest(row.url, apiKey, job.strategy, limiter));
    if (r.error || !r.lab) break; // a failed retest means we can't confirm
    extra.push(r);
    if (!detect(r, base, config.thresholds, rules).kinds.length) break; // already disproved
  }
  const tests = [row, ...extra];
  const best = tests.reduce((x, y) => ((y.lab?.lcp_ms ?? Infinity) < (x.lab?.lcp_ms ?? Infinity) ? y : x));
  const result = extra.length === 2
    ? confirm(tests.map((r) => detect(r, base, config.thresholds, rules)), detect(best, base, config.thresholds, rules))
    : { kinds: [], changes: [], newHosts: [] };
  // Save the fastest of the tests as today's result, so a fluke never becomes part of the baseline.
  rows[index] = { ...best, retested: true, ...(result.kinds.length ? { alert: result.kinds } : {}) };
  if (!result.kinds.length) {
    unconfirmed++;
    return;
  }
  alerts.push({
    site: row.site,
    url: row.url,
    template: templateKey(row.url),
    kinds: result.kinds,
    changes: result.changes,
    causes: explainCauses(best, base, result),
    prevRunId: base.run_id,
  });
});
alerts.sort((a, b) => a.site.localeCompare(b.site) || a.url.localeCompare(b.url));
console.log(`${alerts.length} confirmed, ${unconfirmed} not confirmed.`);

// 4. Save results (committed back to the repo by the workflow).
mkdirSync(RUNS_DIR, { recursive: true });
rows.sort((a, b) => a.site.localeCompare(b.site) || a.url.localeCompare(b.url));
writeFileSync(`${RUNS_DIR}/${runId}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const lagosDate = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-GB", { ...opts, timeZone: "Africa/Lagos" });
const dateLabel = lagosDate(started, { day: "numeric", month: "short", year: "numeric" });
const runIdDate = (id: string) => {
  const d = new Date(`${id.slice(0, 10)}T${id.slice(11, 13)}:${id.slice(13, 15)}:00Z`);
  return Number.isNaN(d.getTime()) ? id : lagosDate(d, { day: "numeric", month: "short" });
};
const runDates = Object.fromEntries(alerts.map((a) => [a.prevRunId, runIdDate(a.prevRunId)]));

const minutes = Math.max(1, Math.round((Date.now() - started.getTime()) / 60_000));
const message = buildMessage({
  dateLabel,
  strategy: strategies.join("+"),
  minutes,
  rows,
  siteCodes: sites.map((s) => s.code),
  sitemapErrors,
  runLink,
  thresholds: config.thresholds,
  alertCount: alerts.length,
  unconfirmed,
  monthMinutes: await minutesThisMonth(started),
});
const alertMessage = buildAlertMessage(alerts, dateLabel, runDates);
const isMondayInLagos = lagosDate(started, { weekday: "long" }) === "Monday";
const sendWeekly = args.weekly === "true" || (args.weekly === "auto" && isMondayInLagos && !limit && !wanted.length);
const weeklyMessage = sendWeekly
  ? buildWeekly(
      latestIncludingErrors(runFiles(RUNS_DIR, started, 7, runId), rows),
      `week to ${lagosDate(started, { day: "numeric", month: "short", year: "numeric" })}`,
    )
  : null;

const report = [message, alertMessage, weeklyMessage].filter(Boolean).join("\n\n----\n\n");
writeFileSync(`${RUNS_DIR}/${runId}-summary.txt`, report + "\n");
console.log("\n" + report);

// 5. Tell Lark: the summary, then alerts (if any), then the weekly list (Mondays).
if (notify && webhook) {
  await sendText(webhook, message);
  if (alertMessage) await sendText(webhook, alertMessage);
  if (weeklyMessage) await sendText(webhook, weeklyMessage);
  console.log(`Sent ${1 + (alertMessage ? 1 : 0) + (weeklyMessage ? 1 : 0)} message(s) to Lark.`);
}
const failed = rows.filter((r) => r.error).length;
if (rows.length && failed === rows.length) {
  console.error("Every test failed. Check the API key and quota.");
  process.exit(1);
}
