// Page lists: read each site's sitemap and choose which pages to test today.
//
// Plain English: most pages are copies of a few templates (blog posts, events,
// database entries). Speed problems usually live in the template, so every day
// we test every one-off page plus a couple of samples of each template, and we
// rotate through the remaining pages so each one is tested once a week.

import { createHash } from "node:crypto";

export const USER_AGENT = "SitePulse/1.0 (GoElite web performance monitor)";

export type Reason = "one-off" | "template-sample" | "rotation" | "full";

export interface Selected {
  url: string;
  reason: Reason;
}

type Fetcher = (url: string) => Promise<string>;

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Sitemap ${url} returned HTTP ${res.status}`);
  return res.text();
}

function decodeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/** Return page URLs and child sitemap URLs from one sitemap file. */
export function parseSitemap(xml: string): { pages: string[]; children: string[] } {
  const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => decodeXml(m[1]));
  return /<sitemapindex[\s>]/.test(xml) ? { pages: [], children: locs } : { pages: locs, children: [] };
}

/** Follow sitemap index files and return every page URL, deduplicated. */
export async function fetchSitemapUrls(sitemapUrl: string, fetcher: Fetcher = defaultFetch, maxDepth = 3) {
  const seen = new Set<string>();
  const pages: string[] = [];
  const queue: Array<[string, number]> = [[sitemapUrl, 0]];
  while (queue.length) {
    const [url, depth] = queue.shift()!;
    if (seen.has(url) || depth > maxDepth) continue;
    seen.add(url);
    const found = parseSitemap(await fetcher(url));
    pages.push(...found.pages);
    for (const c of found.children) queue.push([c, depth + 1]);
  }
  return [...new Set(pages)];
}

/** Drop URLs whose path matches any exclude regex. */
export function applyExcludes(urls: string[], patterns: string[]): string[] {
  const regexes = patterns.map((p) => new RegExp(p));
  return urls.filter((u) => {
    const path = new URL(u).pathname || "/";
    return !regexes.some((r) => r.test(path));
  });
}

/**
 * Group pages that probably share a template.
 *   /blogs/my-post -> /blogs/*
 *   /about-us      -> /about-us (a one-off page)
 */
export function templateKey(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  if (parts.length <= 1) return "/" + parts.join("/");
  return "/" + parts.slice(0, -1).join("/") + "/*";
}

function bucket(url: string, days: number): number {
  const hex = createHash("md5").update(url).digest("hex").slice(0, 12);
  return parseInt(hex, 16) % days;
}

export interface SelectOptions {
  dayNumber: number; // days since 1970-01-01 (UTC)
  rotationDays?: number;
  samplesPerTemplate?: number;
  templateMinPages?: number;
  mode?: "daily" | "full";
}

/** Choose today's pages, each with the reason it was chosen. */
export function selectPages(urls: string[], opts: SelectOptions): Selected[] {
  const { dayNumber, rotationDays = 7, samplesPerTemplate = 2, templateMinPages = 5, mode = "daily" } = opts;
  if (mode === "full") return urls.map((url) => ({ url, reason: "full" as const }));

  const groups = new Map<string, string[]>();
  for (const u of urls) {
    const key = templateKey(u);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(u);
  }

  const chosen = new Map<string, Reason>();
  const add = (u: string, r: Reason) => {
    if (!chosen.has(u)) chosen.set(u, r);
  };
  for (const membersRaw of groups.values()) {
    const members = [...membersRaw].sort();
    if (members.length < templateMinPages) {
      members.forEach((u) => add(u, "one-off"));
      continue;
    }
    // A couple of rotating samples of each template, every day.
    for (let i = 0; i < Math.min(samplesPerTemplate, members.length); i++) {
      add(members[(dayNumber * samplesPerTemplate + i) % members.length], "template-sample");
    }
    // Plus this day's slice of the weekly rotation.
    for (const u of members) {
      if (bucket(u, rotationDays) === dayNumber % rotationDays) add(u, "rotation");
    }
  }
  return [...chosen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([url, reason]) => ({ url, reason }));
}

export function dayNumberUtc(date = new Date()): number {
  return Math.floor(date.getTime() / 86_400_000);
}
