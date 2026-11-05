// Alerts: decide when something got worse, and explain the likely cause.
//
// Plain English: almost every page already misses Google's targets, and Google's
// lab test swings a lot from day to day on the same page (1 test in 10 comes out
// more than twice as slow as the day before, with nothing changed). So:
//   - each page is compared with its own *usual* result: the median of its last 3 results
//   - a page needs at least 2 earlier results before it can alert
//   - only big changes count: main content 2x and 2.5 s+ slower, script freeze 4x and 1.5 s+,
//     layout jumps up by 0.05+, a script from a new source, or a page that usually passes now fails
//   - every suspect is tested twice more, and only alerts if all three tests agree
// Results over 60 s are treated as "needs a look", not as alerts.

import type { Thresholds } from "./config.ts";
import { templateKey } from "./pages.ts";
import type { ResultRow } from "./report.ts";
import { isBlockPage, type PageSummary } from "./psi.ts";

export type AlertKind = "slower" | "new-script" | "now-failing";

export const SUSPICIOUS_LCP_MS = 60_000;

export interface AlertRules {
  lcp_ratio: number;
  lcp_min_ms: number;
  tbt_ratio: number;
  tbt_min_ms: number;
  cls_min_increase: number;
  min_history: number; // earlier results needed before a page can alert
  history_size: number; // how many earlier results form the baseline
}

export const DEFAULT_RULES: AlertRules = {
  lcp_ratio: 2,
  lcp_min_ms: 2500,
  tbt_ratio: 4,
  tbt_min_ms: 1500,
  cls_min_increase: 0.05,
  min_history: 2,
  history_size: 3,
};

export type Metric = "lcp" | "tbt" | "cls";

export interface Detection {
  kinds: AlertKind[];
  changes: string[]; // plain-English "what changed" lines
  newHosts: string[]; // new script sources and new embedded frames
  metrics: Metric[]; // which numbers got worse
}

const EMPTY: Detection = { kinds: [], changes: [], newHosts: [], metrics: [] };

export interface Alert {
  site: string;
  url: string;
  template: string;
  kinds: AlertKind[];
  changes: string[];
  causes: string[];
  prevRunId: string;
  playbook?: string[]; // "Similar past fix" / "Don't retry" / "Known issue" lines
}

const secs = (msv: number) => `${(msv / 1000).toFixed(1)} s`;
const kb = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);

export function isSuspicious(r: ResultRow): boolean {
  return typeof r.lab?.lcp_ms === "number" && r.lab.lcp_ms > SUSPICIOUS_LCP_MS;
}

function median(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * A page's usual result, from its earlier results (oldest first): the median of each number,
 * "passes" if most earlier results passed, and every script source seen before.
 * Returns undefined when there isn't enough history yet.
 */
export function buildBaseline(prevs: ResultRow[] | undefined, rules: AlertRules = DEFAULT_RULES): ResultRow | undefined {
  // Results saved before block-page detection existed are filtered here too.
  const usable = (prevs ?? [])
    .filter((r) => !r.error && r.lab && r.hints && !isSuspicious(r) && !isBlockPage(r as PageSummary))
    .slice(-rules.history_size);
  if (usable.length < rules.min_history) return undefined;
  const last = usable[usable.length - 1];
  const withScripts = usable.filter((r) => r.scripts);
  const lab = {
    lcp_ms: median(usable.map((r) => r.lab!.lcp_ms)),
    cls: median(usable.map((r) => r.lab!.cls)),
    tbt_ms: median(usable.map((r) => r.lab!.tbt_ms)),
    fcp_ms: median(usable.map((r) => r.lab!.fcp_ms)),
    si_ms: median(usable.map((r) => r.lab!.si_ms)),
    bytes: median(usable.map((r) => r.lab!.bytes)),
  };
  return {
    ...last,
    lab,
    pass: usable.filter((r) => r.pass === true).length * 2 > usable.length,
    // Scripts (and embedded frames) are compared only when every earlier result recorded them.
    ...(withScripts.length === usable.length
      ? {
          scripts: {
            hosts: [...new Set(withScripts.flatMap((r) => r.scripts!.hosts))].sort(),
            count: last.scripts!.count,
            bytes: last.scripts!.bytes,
            ...(withScripts.every((r) => Array.isArray(r.scripts!.frames))
              ? { frames: [...new Set(withScripts.flatMap((r) => r.scripts!.frames!))].sort() }
              : {}),
          },
        }
      : { scripts: undefined }),
  };
}

/** Compare a page's result with its usual (baseline) result. */
export function detect(now: ResultRow, base: ResultRow | undefined, t: Thresholds, rules: AlertRules = DEFAULT_RULES): Detection {
  const out: Detection = { kinds: [], changes: [], newHosts: [], metrics: [] };
  if (!base || now.error || !now.lab || !base.lab) return out;
  const a = base.lab;
  const b = now.lab;

  if (!isSuspicious(now)) {
    const slower: string[] = [];
    if (a.lcp_ms !== null && b.lcp_ms !== null && b.lcp_ms >= a.lcp_ms * rules.lcp_ratio && b.lcp_ms - a.lcp_ms >= rules.lcp_min_ms) {
      slower.push(`Main content shows: usually ${secs(a.lcp_ms)}, now ${secs(b.lcp_ms)}`);
      out.metrics.push("lcp");
    }
    if (a.tbt_ms !== null && b.tbt_ms !== null && b.tbt_ms >= Math.max(a.tbt_ms, 50) * rules.tbt_ratio && b.tbt_ms - a.tbt_ms >= rules.tbt_min_ms) {
      slower.push(`Page frozen by scripts (TBT): usually ${Math.round(a.tbt_ms)} ms, now ${b.tbt_ms} ms`);
      out.metrics.push("tbt");
    }
    if (a.cls !== null && b.cls !== null && b.cls > t.cls && b.cls - a.cls >= rules.cls_min_increase) {
      slower.push(`Layout jumping (CLS): usually ${a.cls}, now ${b.cls}`);
      out.metrics.push("cls");
    }
    if (slower.length) {
      out.kinds.push("slower");
      out.changes.push(...slower);
    }
  }

  // Older saved results have no script list; never treat everything as "new" against them.
  if (base.scripts && now.scripts) {
    const before = new Set(base.scripts.hosts);
    const newScripts = now.scripts.hosts.filter((h) => !before.has(h));
    // Embedded frames are compared only once earlier results recorded them too.
    const framesBefore = base.scripts.frames ? new Set(base.scripts.frames) : null;
    const newFrames = framesBefore && now.scripts.frames ? now.scripts.frames.filter((h) => !framesBefore.has(h) && !before.has(h)) : [];
    out.newHosts = [...new Set([...newScripts, ...newFrames])];
    if (out.newHosts.length) {
      out.kinds.push("new-script");
      const list = (xs: string[]) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? ` (+${xs.length - 3})` : ""}`;
      if (newScripts.length) out.changes.push(`New script source: ${list(newScripts)}`);
      if (newFrames.length) out.changes.push(`New embed (calendar, video, chat…): ${list(newFrames)}`);
    }
  }

  if (base.pass === true && now.pass === false) {
    out.kinds.push("now-failing");
    out.changes.push("Usually passes Google's targets, fails now");
  }
  return out;
}

/**
 * Keep only what every test agrees on. `report` is the detection of the test whose
 * numbers are shown (the fastest of the tests, so the alert never overstates).
 */
export function confirm(all: Detection[], report: Detection): Detection {
  const kinds = all[0].kinds.filter((k) => all.every((d) => d.kinds.includes(k)));
  if (!kinds.length) return { ...EMPTY };
  const newHosts = all[0].newHosts.filter((h) => all.every((d) => d.newHosts.includes(h)));
  const metrics = all[0].metrics.filter((m) => all.every((d) => d.metrics.includes(m)));
  const isNew = (c: string) => c.startsWith("New script") || c.startsWith("New embed");
  const changes = report.changes.filter((c) =>
    (isNew(c) && kinds.includes("new-script")) ||
    (c.startsWith("Usually passes") && kinds.includes("now-failing")) ||
    (!isNew(c) && !c.startsWith("Usually passes") && kinds.includes("slower")),
  );
  return { kinds, changes, newHosts, metrics };
}

// The breakdown comes from the real page load, while the headline number is a simulated
// slow-phone load, so the seconds don't line up. We name the biggest part instead.
const PHASES: Record<string, (share: string, el: string) => string> = {
  timeToFirstByte: (share) => `Most of the wait (${share}) is the server being slow to start sending the page`,
  resourceLoadDelay: (share, el) => `Most of the wait (${share}) is the main image${el} starting to download late, so it may be lazy-loaded or not preloaded`,
  resourceLoadDuration: (share, el) => `Most of the wait (${share}) is the main image${el} downloading, so it may be too large`,
  elementRenderDelay: (share, el) => `Most of the wait (${share}) is the main element${el} being ready but not shown yet, usually because scripts or styles block it`,
};

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const file = x.pathname.split("/").filter(Boolean).pop() ?? "/";
    return `${x.host}/…/${file}`.slice(0, 80);
  } catch {
    return u.slice(0, 80);
  }
}

/** Up to 3 plain-English likely causes, most specific first. */
export function explainCauses(now: ResultRow, prev: ResultRow | undefined, d: Detection): string[] {
  const causes: string[] = [];
  const h = now.hints;
  if (d.newHosts.length) causes.push(`Something new is loading from ${d.newHosts.slice(0, 2).join(" and ")}`);

  const nowEl = h?.lcp_element;
  const prevEl = prev?.hints?.lcp_element;
  if (nowEl?.selector && prevEl?.selector && nowEl.selector !== prevEl.selector) {
    causes.push(`The main element changed: was "${prevEl.label ?? prevEl.selector}", now "${nowEl.label ?? nowEl.selector}"`);
  }

  // Loading-phase causes only make sense when the page actually got slower or started failing.
  const slowed = d.kinds.includes("slower") || d.kinds.includes("now-failing");
  const phases = slowed ? h?.lcp_breakdown ?? {} : {};
  const prevPhases = prev?.hints?.lcp_breakdown ?? {};
  const names = Object.keys(phases).filter((p) => PHASES[p]);
  if (names.length) {
    // Prefer the phase that grew the most since last time; otherwise the biggest one.
    const grew = names
      .map((p) => ({ p, grow: phases[p] - (prevPhases[p] ?? phases[p]) }))
      .sort((x, y) => y.grow - x.grow)[0];
    const pick = grew && grew.grow > 300 ? grew.p : names.sort((x, y) => phases[y] - phases[x])[0];
    const el = nowEl?.label ? ` ("${nowEl.label.slice(0, 40)}")` : "";
    const total = names.reduce((a, p) => a + Math.max(0, phases[p]), 0) || 1;
    causes.push(PHASES[pick](`${Math.round((100 * Math.max(0, phases[pick])) / total)}%`, el));
    if (pick === "elementRenderDelay" && h?.render_blocking?.[0]) {
      causes.push(`Biggest blocking file: ${shortUrl(h.render_blocking[0].url)}`);
    }
  }

  const tp = h?.third_parties?.[0];
  if (d.changes.some((c) => c.includes("TBT")) && tp?.name) {
    causes.push(`Heaviest third-party script: ${tp.name}${tp.blocking_ms ? ` (${tp.blocking_ms} ms of work)` : ""}`);
  }

  const bNow = now.lab?.bytes;
  const bPrev = prev?.lab?.bytes;
  if (bNow && bPrev && bNow > bPrev * 1.3 && bNow - bPrev > 200_000) {
    causes.push(`The page got heavier: ${kb(bPrev)} → ${kb(bNow)}`);
  }
  return [...new Set(causes)].slice(0, 3);
}

/** Build the alert message. Pages from the same template that broke together are grouped. */
export function buildAlertMessage(alerts: Alert[], dateLabel: string, runDates: Record<string, string>, max = 10): string | null {
  if (!alerts.length) return null;
  const groups = new Map<string, Alert[]>();
  for (const a of alerts) {
    const k = `${a.site} ${a.template}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  const lines = [`SitePulse alert: ${alerts.length} ${alerts.length === 1 ? "page got" : "pages got"} worse (${dateLabel}, confirmed by 3 tests)`];
  let n = 0;
  for (const [, items] of groups) {
    if (n >= max) break;
    n++;
    const first = items[0];
    const path = new URL(first.url).pathname;
    lines.push("");
    lines.push(items.length > 1
      ? `${n}. ${first.site} template ${first.template}: ${items.length} pages (e.g. ${path})`
      : `${n}. ${first.site} ${path}`);
    for (const c of first.changes) lines.push(`   ${c}`);
    for (const c of first.causes) lines.push(`   Likely cause: ${c}`);
    for (const p of first.playbook ?? []) lines.push(`   ${p}`);
    lines.push(`   Compared with: its usual result (last tests up to ${runDates[first.prevRunId] ?? first.prevRunId})`);
  }
  if (groups.size > max) lines.push("", `+${groups.size - max} more in today's results file.`);
  return lines.join("\n");
}

export { templateKey };
