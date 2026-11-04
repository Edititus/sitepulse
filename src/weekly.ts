// Weekly "worst pages" list: the pages that are already failing don't alert every
// day, so once a week they are listed here instead, with anything that needs a look.

import { SUSPICIOUS_LCP_MS } from "./alerts.ts";
import { keyOf, readRows } from "./history.ts";
import type { ResultRow } from "./report.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const secs = (msv: number) => `${(msv / 1000).toFixed(1)} s`;
const path = (u: string) => {
  const p = new URL(u).pathname;
  return p.length > 60 ? p.slice(0, 57) + "..." : p;
};

/** Latest row per page across the files, including pages whose latest test failed. */
export function latestIncludingErrors(files: string[], extra: ResultRow[] = []): ResultRow[] {
  const latest = new Map<string, ResultRow>();
  for (const f of files) for (const r of readRows(f)) latest.set(keyOf(r), r);
  for (const r of extra) latest.set(keyOf(r), r);
  return [...latest.values()];
}

export function buildWeekly(rows: ResultRow[], weekLabel: string, top = 10): string {
  const ok = rows.filter((r) => !r.error && typeof r.lab?.lcp_ms === "number");
  const realistic = ok.filter((r) => r.lab!.lcp_ms! <= SUSPICIOUS_LCP_MS);
  const suspicious = ok.filter((r) => r.lab!.lcp_ms! > SUSPICIOUS_LCP_MS);
  const failedTests = rows.filter((r) => r.error);
  const passing = ok.filter((r) => r.pass).length;

  const lines = [`SitePulse weekly report: ${weekLabel}`];
  lines.push(`${plural(rows.length, "page", "pages")} tested this week · ${ok.length ? Math.round((100 * passing) / ok.length) : 0}% pass Google's targets.`);

  lines.push("", `Slowest ${Math.min(top, realistic.length)} pages (time until main content shows):`);
  realistic
    .sort((a, b) => b.lab!.lcp_ms! - a.lab!.lcp_ms!)
    .slice(0, top)
    .forEach((r, i) => lines.push(`${i + 1}. ${r.site} ${path(r.url)}: ${secs(r.lab!.lcp_ms!)} (score ${r.score ?? "n/a"})`));

  if (suspicious.length) {
    lines.push("", `Needs a look: ${plural(suspicious.length, "page", "pages")} measured over 60 s, usually a popup or banner that appears very late:`);
    suspicious
      .sort((a, b) => b.lab!.lcp_ms! - a.lab!.lcp_ms!)
      .slice(0, top)
      .forEach((r) => {
        const el = r.hints?.lcp_element?.label || r.hints?.lcp_element?.selector;
        lines.push(`- ${r.site} ${path(r.url)}: ${secs(r.lab!.lcp_ms!)}${el ? ` (late element: "${el.slice(0, 50)}")` : ""}`);
      });
  }

  if (failedTests.length) {
    lines.push("", `Could not be tested (${failedTests.length}):`);
    failedTests.slice(0, top).forEach((r) => lines.push(`- ${r.site} ${path(r.url)}: ${r.error}`));
  }
  return lines.join("\n");
}
