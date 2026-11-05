// Fix playbook: match an alert to the fixes that worked before (playbook.json).
//
// Plain English: the playbook lists this fall's fixes, each with the signs that
// point to it (which scripts or embeds load, which part of the load is slowest,
// what the main element is). When an alert shows the same signs, the alert names
// the past fix. Things that were tried and failed are mentioned so nobody repeats
// them, and known unfixed issues are flagged.

import { existsSync, readFileSync } from "node:fs";
import type { Detection, Metric } from "./alerts.ts";
import type { ResultRow } from "./report.ts";

export interface Signals {
  new_hosts_any?: string[]; // script/embed source that is NEW on the page (a deferral stopped working)
  frames_any?: string[];
  hosts_any?: string[];
  metrics_any?: Metric[];
  phase?: string;
  lcp_snippet_any?: string[];
  top_third_party_any?: string[];
}

export interface Fix {
  id: string;
  title: string;
  past: string;
  fix: string;
  result?: string;
  watch_out?: string;
  signals: Signals;
  site_notes?: Record<string, string>;
}

export interface Playbook {
  fixes: Fix[];
  avoid: Array<{ title: string; sites?: string[]; why: string; signals?: Signals }>;
  known_issues: Array<{ site: string; path: string; title: string; signals?: Signals }>;
}

export function loadPlaybook(path = "playbook.json"): Playbook | null {
  if (!existsSync(path)) return null;
  const p = JSON.parse(readFileSync(path, "utf8")) as Playbook;
  return { fixes: p.fixes ?? [], avoid: p.avoid ?? [], known_issues: p.known_issues ?? [] };
}

/** The biggest part of the main-content delay, e.g. "resourceLoadDelay". */
export function dominantPhase(row: ResultRow): string | null {
  const phases = row.hints?.lcp_breakdown ?? {};
  const best = Object.entries(phases).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** "usemessages.com" matches "usemessages.com" and "js-na2.usemessages.com". */
export function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith("." + pattern);
}

/** How many of the signals hold (null if any of them fails). More signals = more specific match. */
export function matchSignals(s: Signals | undefined, row: ResultRow, d: Detection): number | null {
  if (!s) return 0;
  let score = 0;
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const frames = lower(row.scripts?.frames ?? []);
  const hosts = lower(row.scripts?.hosts ?? []);
  const fresh = lower(d.newHosts);
  if (s.new_hosts_any) {
    if (!lower(s.new_hosts_any).some((p) => fresh.some((h) => hostMatches(h, p)))) return null;
    score += 10; // what just appeared is the most likely cause
  }
  if (s.frames_any) {
    if (!lower(s.frames_any).some((p) => frames.some((h) => hostMatches(h, p)))) return null;
    score++;
  }
  if (s.hosts_any) {
    if (!lower(s.hosts_any).some((p) => hosts.some((h) => hostMatches(h, p)))) return null;
    score++;
  }
  if (s.metrics_any) {
    // "Now fails Google's targets" alerts have no single metric, so any metric signal may apply.
    const anyMetric = d.kinds.includes("now-failing") && !d.metrics.length;
    if (!anyMetric && !s.metrics_any.some((m) => d.metrics.includes(m))) return null;
    score++;
  }
  if (s.phase) {
    if (dominantPhase(row) !== s.phase) return null;
    score++;
  }
  if (s.lcp_snippet_any) {
    const snip = (row.hints?.lcp_element?.snippet ?? "").toLowerCase();
    if (!lower(s.lcp_snippet_any).some((x) => snip.includes(x))) return null;
    score++;
  }
  if (s.top_third_party_any) {
    const top = (row.hints?.third_parties?.[0]?.name ?? "").toLowerCase();
    if (!top || !lower(s.top_third_party_any).some((x) => top.includes(x))) return null;
    score++;
  }
  return score;
}

/** Up to 3 lines for an alert: the closest past fix, anything not to retry, a known issue. */
export function playbookLines(pb: Playbook | null, row: ResultRow, d: Detection): string[] {
  if (!pb) return [];
  const lines: string[] = [];
  const path = new URL(row.url).pathname;

  const best = pb.fixes
    .map((f) => ({ f, score: matchSignals(f.signals, row, d) }))
    .filter((x): x is { f: Fix; score: number } => x.score !== null && x.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (best) {
    const f = best.f;
    lines.push(`Similar past fix: ${f.title} (${f.past}). What worked: ${f.fix}.${f.result ? ` Result: ${f.result}.` : ""}`);
    if (f.site_notes?.[row.site]) lines.push(`Careful on ${row.site}: ${f.site_notes[row.site]}`);
    else if (f.watch_out) lines.push(`Watch out: ${f.watch_out}.`);
  }

  const avoid = pb.avoid.find((a) => (!a.sites || a.sites.includes(row.site)) && (matchSignals(a.signals, row, d) ?? -1) > 0);
  if (avoid) lines.push(`Don't retry: ${avoid.title} (${avoid.why}).`);

  const known = pb.known_issues.find(
    (k) => (k.site === "*" || k.site === row.site) && new RegExp(k.path).test(path) && (matchSignals(k.signals, row, d) ?? -1) >= 0,
  );
  if (known) lines.push(`Known issue: ${known.title}.`);
  return lines.slice(0, 4);
}
