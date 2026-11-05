// Google PageSpeed Insights: run the test for one page and keep the useful parts.
//
// Plain English: Google loads the page on a simulated phone and reports how long
// the main content took to appear (LCP), how much the layout jumped (CLS) and how
// long scripts froze the page (TBT). If enough real visitors use the page, Google
// also reports what those real visitors experienced (field data, incl. INP).

import type { Strategy } from "./config.ts";

// SITEPULSE_PSI_ENDPOINT exists only for local end-to-end tests.
const PSI_ENDPOINT = process.env.SITEPULSE_PSI_ENDPOINT || "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** Allow at most `perMinute` request starts in any rolling 60 seconds. */
export class RateLimiter {
  private starts: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private perMinute: number;
  private windowMs: number;

  constructor(perMinute: number, windowMs = 60_000) {
    this.perMinute = perMinute;
    this.windowMs = windowMs;
  }

  wait(): Promise<void> {
    // Callers queue up one behind another so the count is never exceeded.
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.starts = this.starts.filter((t) => now - t < this.windowMs);
        if (this.starts.length < this.perMinute) {
          this.starts.push(now);
          return;
        }
        await sleep(this.windowMs - (now - this.starts[0]) + 50);
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FieldData {
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  category: string | null;
  origin_fallback: boolean;
}

export interface PageSummary {
  score: number | null;
  lab: {
    lcp_ms: number | null;
    cls: number | null;
    tbt_ms: number | null;
    fcp_ms: number | null;
    si_ms: number | null;
    bytes: number | null;
  };
  field: FieldData | null;
  origin_field: FieldData | null;
  hints: {
    lcp_element: { label: string | null; selector: string | null; snippet: string | null } | null;
    lcp_breakdown: Record<string, number>; // e.g. timeToFirstByte, elementRenderDelay (ms)
    render_blocking: Array<{ url: string; wasted_ms: number | null }>;
    third_parties: Array<{ name: string; blocking_ms: number | null; bytes: number | null }>;
  };
  /** Every script the page loaded, by host. Used to spot new scripts. Absent on rows saved before Nov 2026. */
  scripts?: { hosts: string[]; count: number; bytes: number; frames?: string[] };
  lighthouse: string | null;
}

type Json = any; // PageSpeed responses are large and loosely shaped.

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ms = (v: unknown): number | null => (num(v) === null ? null : Math.round(v as number));

function findFirst(obj: Json, key: string): Json | null {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findFirst(v, key);
      if (hit) return hit;
    }
  } else if (obj && typeof obj === "object") {
    if (key in obj) return obj;
    for (const v of Object.values(obj)) {
      const hit = findFirst(v, key);
      if (hit) return hit;
    }
  }
  return null;
}

function itemsOf(audits: Json, ...names: string[]): Json[] {
  for (const n of names) {
    const items = audits?.[n]?.details?.items;
    if (Array.isArray(items) && items.length) return items;
  }
  return [];
}

function entityName(e: Json): string {
  if (e && typeof e === "object") return String(e.text ?? e.url ?? "");
  return String(e ?? "");
}

function field(exp: Json): FieldData | null {
  if (!exp?.metrics) return null;
  const p = (name: string) => num(exp.metrics?.[name]?.percentile);
  const cls = p("CUMULATIVE_LAYOUT_SHIFT_SCORE"); // reported x100 (5 means 0.05)
  return {
    lcp_ms: p("LARGEST_CONTENTFUL_PAINT_MS"),
    inp_ms: p("INTERACTION_TO_NEXT_PAINT"),
    cls: cls === null ? null : Math.round(cls * 10) / 1000,
    category: exp.overall_category ?? null,
    origin_fallback: Boolean(exp.origin_fallback),
  };
}

/** Turn the big PageSpeed response into a small record we can store daily. */
export function summarize(psi: Json): PageSummary {
  const lhr = psi?.lighthouseResult ?? {};
  const audits = lhr.audits ?? {};
  const perf = num(lhr.categories?.performance?.score);
  const value = (name: string) => audits[name]?.numericValue;
  const cls = num(value("cumulative-layout-shift"));
  // Lighthouse 13 moved these into "insight" audits; older names kept as a fallback.
  const lcpDetails = audits["lcp-breakdown-insight"]?.details ?? audits["largest-contentful-paint-element"]?.details;
  const lcpNode = findFirst(lcpDetails, "snippet");
  const lcpBreakdown: Record<string, number> = {};
  const phaseTable = (Array.isArray(lcpDetails?.items) ? lcpDetails.items : []).find((i: Json) => i?.type === "table");
  for (const p of Array.isArray(phaseTable?.items) ? phaseTable.items : []) {
    const key = p?.subpart ?? p?.phase;
    if (typeof key === "string" && num(p?.duration ?? p?.timing) !== null) lcpBreakdown[key] = Math.round(p.duration ?? p.timing);
  }

  const blocking = itemsOf(audits, "render-blocking-insight", "render-blocking-resources");
  const cost = (x: Json) => num(x?.blockingTime) ?? num(x?.mainThreadTime) ?? 0;
  const third = itemsOf(audits, "third-parties-insight", "third-party-summary")
    .filter((x) => x && typeof x === "object")
    .sort((a, b) => cost(b) - cost(a));

  const requests = itemsOf(audits, "network-requests");
  const scriptReqs = requests.filter((r) => r?.resourceType === "Script" && typeof r?.url === "string");
  const hosts = new Set<string>();
  for (const r of scriptReqs) {
    try {
      hosts.add(new URL(r.url).host);
    } catch {}
  }
  // Embedded frames (calendars, videos, chat) load as extra documents after the page itself.
  const mainHost = (() => {
    try {
      return new URL(String(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? requests[0]?.url)).host;
    } catch {
      return "";
    }
  })();
  const frames = new Set<string>();
  requests.forEach((r, i) => {
    if (i === 0 || r?.resourceType !== "Document" || typeof r?.url !== "string") return;
    try {
      const h = new URL(r.url).host;
      if (h && h !== mainHost) frames.add(h);
    } catch {}
  });
  const scripts = requests.length
    ? {
        hosts: [...hosts].sort().slice(0, 60),
        count: scriptReqs.length,
        bytes: Math.round(scriptReqs.reduce((a, r) => a + (num(r.transferSize) ?? 0), 0)),
        frames: [...frames].sort().slice(0, 30),
      }
    : undefined;

  return {
    score: perf === null ? null : Math.round(perf * 100),
    lab: {
      lcp_ms: ms(value("largest-contentful-paint")),
      cls: cls === null ? null : Math.round(cls * 1000) / 1000,
      tbt_ms: ms(value("total-blocking-time")),
      fcp_ms: ms(value("first-contentful-paint")),
      si_ms: ms(value("speed-index")),
      bytes: ms(value("total-byte-weight")),
    },
    field: field(psi?.loadingExperience),
    origin_field: field(psi?.originLoadingExperience),
    hints: {
      lcp_element: lcpNode
        ? {
            label: typeof lcpNode.nodeLabel === "string" ? lcpNode.nodeLabel.slice(0, 120) : null,
            selector: typeof lcpNode.selector === "string" ? lcpNode.selector.slice(0, 200) : null,
            snippet: typeof lcpNode.snippet === "string" ? lcpNode.snippet.slice(0, 200) : null,
          }
        : null,
      lcp_breakdown: lcpBreakdown,
      render_blocking: blocking
        .filter((i) => typeof i?.url === "string")
        .slice(0, 3)
        .map((i) => ({ url: i.url, wasted_ms: ms(i.wastedMs) })),
      third_parties: third.slice(0, 3).map((i) => ({
        name: entityName(i.entity),
        blocking_ms: ms(cost(i)),
        bytes: ms(i.transferSize),
      })),
    },
    ...(scripts ? { scripts } : {}),
    lighthouse: lhr.lighthouseVersion ?? null,
  };
}

// Wording of firewall / bot-protection pages. Google's test is sometimes shown one of these
// instead of the real page; that result says nothing about the page's speed.
const BLOCK_PAGE = /you[’']ve been blocked|blocked for security reasons|access denied|attention required|just a moment\.\.\.|verify you are human|checking your browser/i;

export function isBlockPage(s: PageSummary): boolean {
  const el = s.hints.lcp_element;
  return BLOCK_PAGE.test(`${el?.label ?? ""} ${el?.snippet ?? ""}`);
}

export interface TestResult {
  summary: PageSummary | null;
  error: string | null;
}

type Fetch = typeof fetch;

/** Run one PageSpeed test, retrying temporary failures. Never logs the API key. */
export async function runTest(
  url: string,
  apiKey: string,
  strategy: Strategy,
  limiter: RateLimiter,
  { retries = 2, timeoutMs = 120_000, fetcher = fetch as Fetch, backoffMs = 20_000 } = {},
): Promise<TestResult> {
  const params = new URLSearchParams({ url, strategy, category: "performance", key: apiKey });
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.wait();
    try {
      const res = await fetcher(`${PSI_ENDPOINT}?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const summary = summarize(await res.json());
        if (isBlockPage(summary)) return { summary: null, error: "Blocked by the site's security check (Google's test was shown a block page)" };
        return { summary, error: null };
      }
      let message = "";
      try {
        message = String((await res.json())?.error?.message ?? "").slice(0, 200);
      } catch {}
      lastError = `HTTP ${res.status}${message ? ": " + message : ""}`;
      if ([400, 403, 404].includes(res.status)) break; // bad URL, bad key, unreachable page
      await sleep(res.status === 429 ? 60_000 : backoffMs);
    } catch (e) {
      lastError = (e as Error)?.name || "network error"; // e.g. TimeoutError
      await sleep(backoffMs);
    }
  }
  return { summary: null, error: lastError };
}
