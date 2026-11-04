// Turn a run's results into numbers per site and the daily Lark message.

import type { Thresholds } from "./config.ts";
import type { PageSummary } from "./psi.ts";
import type { Reason } from "./pages.ts";

export interface ResultRow extends Partial<PageSummary> {
  run_id: string;
  site: string;
  url: string;
  reason: Reason;
  strategy: string;
  error: string | null;
  pass: boolean | null; // null when the test failed
  retested?: boolean; // tested twice because it looked worse; the faster result is kept
  alert?: string[]; // confirmed alert kinds, if any
}

/** Lab "pass" uses Google's "good" targets. INP needs real visitors, so it's not in the lab check. */
export function passes(s: PageSummary, t: Thresholds): boolean | null {
  const { lcp_ms, cls, tbt_ms } = s.lab;
  if (lcp_ms === null || cls === null || tbt_ms === null) return null;
  return lcp_ms <= t.lcp_ms && cls <= t.cls && tbt_ms <= t.tbt_ms;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

export interface SiteStats {
  site: string;
  tested: number;
  errors: number;
  pass_rate: number | null; // 0..100
  median_score: number | null;
  median_lcp_ms: number | null;
}

export function siteStats(rows: ResultRow[], site: string): SiteStats {
  const mine = rows.filter((r) => r.site === site);
  const ok = mine.filter((r) => !r.error && r.lab);
  const judged = ok.filter((r) => r.pass !== null);
  return {
    site,
    tested: ok.length,
    errors: mine.length - ok.length,
    pass_rate: judged.length ? Math.round((100 * judged.filter((r) => r.pass).length) / judged.length) : null,
    median_score: median(ok.map((r) => r.score).filter((x): x is number => typeof x === "number")),
    median_lcp_ms: median(ok.map((r) => r.lab!.lcp_ms).filter((x): x is number => typeof x === "number")),
  };
}

const secs = (msv: number | null | undefined) => (typeof msv === "number" ? `${(msv / 1000).toFixed(1)} s` : "n/a");

function shortPath(url: string): string {
  const p = new URL(url).pathname;
  return p.length > 60 ? p.slice(0, 57) + "..." : p;
}

export interface MessageInput {
  dateLabel: string;
  strategy: string;
  minutes: number;
  rows: ResultRow[];
  siteCodes: string[];
  sitemapErrors: Record<string, string>;
  runLink: string | null;
  thresholds: Thresholds;
  alertCount?: number; // confirmed alerts (sent as a separate message)
  unconfirmed?: number; // looked worse once but the second test disagreed
  monthMinutes?: number | null; // GitHub Actions minutes used this month
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SUSPICIOUS_MS = 60_000;

export function buildMessage(m: MessageInput): string {
  const stats = m.siteCodes.map((s) => siteStats(m.rows, s));
  const tested = stats.reduce((a, s) => a + s.tested, 0);
  const errors = stats.reduce((a, s) => a + s.errors, 0);
  const lines: string[] = [];
  lines.push(`SitePulse daily check: ${m.dateLabel} (${m.strategy}, lab test)`);
  lines.push(`Tested ${plural(tested, "page", "pages")} on ${plural(m.siteCodes.length, "site", "sites")} in ${m.minutes} min.` +
    (errors ? ` ${errors} could not be tested.` : ""));
  lines.push(`Pass = LCP ≤ ${m.thresholds.lcp_ms / 1000} s, CLS ≤ ${m.thresholds.cls}, TBT ≤ ${m.thresholds.tbt_ms} ms.`);
  if (m.alertCount !== undefined) {
    lines.push(m.alertCount
      ? `⚠ ${plural(m.alertCount, "page got", "pages got")} worse since last check (see the alert message).`
      : "No page got worse than its usual result." + (m.unconfirmed ? ` (${m.unconfirmed} looked worse at first, but the retests were fine.)` : ""));
  }
  lines.push("");
  for (const s of stats) {
    if (m.sitemapErrors[s.site]) {
      lines.push(`${s.site}: sitemap could not be read (${m.sitemapErrors[s.site]})`);
      continue;
    }
    lines.push(
      `${s.site}: ${s.tested} tested · ${s.pass_rate === null ? "pass rate n/a" : `${s.pass_rate}% pass`} · median score ${s.median_score ?? "n/a"} · median LCP ${secs(s.median_lcp_ms)}` +
        (s.errors ? ` · ${plural(s.errors, "error", "errors")}` : ""),
    );
  }
  const measured = m.rows.filter((r) => !r.error && typeof r.lab?.lcp_ms === "number");
  const slowest = measured
    .filter((r) => r.lab!.lcp_ms! <= SUSPICIOUS_MS)
    .sort((a, b) => b.lab!.lcp_ms! - a.lab!.lcp_ms!)
    .slice(0, 5);
  if (slowest.length) {
    lines.push("");
    lines.push("Slowest pages (time until main content shows):");
    slowest.forEach((r, i) => lines.push(`${i + 1}. ${r.site} ${shortPath(r.url)}: ${secs(r.lab!.lcp_ms)} (score ${r.score ?? "n/a"})`));
  }
  const odd = measured.filter((r) => r.lab!.lcp_ms! > SUSPICIOUS_MS);
  if (odd.length) {
    lines.push("");
    lines.push(`Needs a look: ${plural(odd.length, "page", "pages")} measured over 60 s, usually a popup or banner that appears very late: ` +
      odd.slice(0, 3).map((r) => `${r.site} ${shortPath(r.url)}`).join(", ") + (odd.length > 3 ? ", ..." : ""));
  }
  const failed = m.rows.filter((r) => r.error);
  if (failed.length) {
    lines.push("");
    lines.push("Could not be tested:");
    failed.slice(0, 5).forEach((r) => lines.push(`- ${r.site} ${shortPath(r.url)}: ${r.error}`));
    if (failed.length > 5) lines.push(`- +${failed.length - 5} more in the results file`);
  }
  if (typeof m.monthMinutes === "number") {
    lines.push("");
    lines.push(`GitHub minutes used this month: about ${m.monthMinutes} of 2,000 free.`);
  }
  if (m.runLink) {
    lines.push("");
    lines.push(`Full results: ${m.runLink}`);
  }
  return lines.join("\n");
}
