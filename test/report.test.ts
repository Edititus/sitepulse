import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage, siteStats, type ResultRow } from "../src/report.ts";

const thresholds = { lcp_ms: 2500, cls: 0.1, tbt_ms: 200, inp_ms: 200 };

function row(site: string, path: string, lcp: number | null, pass: boolean | null, error: string | null = null): ResultRow {
  return {
    run_id: "r", site, url: `https://${site.toLowerCase()}.com${path}`, reason: "one-off", strategy: "mobile", error, pass,
    ...(error ? {} : { score: 50, lab: { lcp_ms: lcp, cls: 0, tbt_ms: 0, fcp_ms: 0, si_ms: 0, bytes: 0 } }),
  };
}

test("site stats count passes and errors", () => {
  const rows = [row("A", "/", 2000, true), row("A", "/x", 6000, false), row("A", "/y", null, null, "HTTP 500")];
  assert.deepEqual(siteStats(rows, "A"), { site: "A", tested: 2, errors: 1, pass_rate: 50, median_score: 50, median_lcp_ms: 4000 });
});

test("message lists sites, slowest pages and the run link, and always contains the bot keyword", () => {
  const rows = [row("A", "/", 2000, true), row("A", "/slow", 9000, false), row("B", "/", null, null, "HTTP 500")];
  const text = buildMessage({
    dateLabel: "30 Oct 2026", strategy: "mobile", minutes: 3, rows, siteCodes: ["A", "B", "C"],
    sitemapErrors: { C: "HTTP 404" }, runLink: "https://github.com/x/y/actions/runs/1", thresholds,
  });
  assert.match(text, /^SitePulse daily check/);
  assert.match(text, /A: 2 tested · 50% pass/);
  assert.match(text, /B: 0 tested · pass rate n\/a .* 1 error$/m);
  assert.match(text, /C: sitemap could not be read/);
  assert.match(text, /1\. A \/slow: 9\.0 s/);
  assert.match(text, /Full results: https:\/\/github\.com/);
});
