// Settings for SitePulse, read from sites.json at the repository root.

import { readFileSync } from "node:fs";

export type Strategy = "mobile" | "desktop";

export interface Site {
  code: string; // short name, e.g. "D1CU"
  name: string;
  url: string;
  sitemap: string;
  exclude: string[]; // regexes matched against the URL path, e.g. "^/zh(/|$)"
}

export interface Thresholds {
  lcp_ms: number;
  cls: number;
  tbt_ms: number;
  inp_ms: number;
}

export interface AlertSettings {
  lcp_ratio?: number;
  lcp_min_ms?: number;
  tbt_ratio?: number;
  tbt_min_ms?: number;
  cls_min_increase?: number;
  min_history?: number;
  history_size?: number;
  max_suspects?: number; // pages re-tested per run (2 extra tests each)
}

export interface Config {
  strategies: Strategy[];
  rate_per_minute: number;
  concurrency: number;
  rotation_days: number;
  samples_per_template: number;
  template_min_pages: number;
  thresholds: Thresholds;
  alerts?: AlertSettings;
  sites: Site[];
}

export function loadConfig(path = "sites.json"): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (!Array.isArray(config.sites) || config.sites.length === 0) {
    throw new Error("sites.json has no sites");
  }
  if (config.rate_per_minute > 30) {
    throw new Error("rate_per_minute must stay at or below Google's limit of 30");
  }
  return config;
}
