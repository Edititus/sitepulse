// Past results: read the saved runs so each page can be compared with its own last result.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultRow } from "./report.ts";

const RUN_FILE = /^(\d{4}-\d{2}-\d{2})_(\d{4})\.jsonl$/;

export const keyOf = (r: { url: string; strategy: string }) => `${r.strategy} ${r.url}`;

/** Run files from the last `days` days, oldest first, excluding the current run. */
export function runFiles(dir: string, now: Date, days: number, excludeRunId?: string): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return readdirSync(dir)
    .filter((f) => RUN_FILE.test(f))
    .filter((f) => f.slice(0, 10) >= cutoff)
    .filter((f) => !excludeRunId || f !== `${excludeRunId}.jsonl`)
    .sort()
    .map((f) => join(dir, f));
}

export function readRows(file: string): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A damaged line should never stop the daily run.
    }
  }
  return rows;
}

/** The most recent successful result for each page (per strategy). */
export function latestByPage(files: string[]): Map<string, ResultRow> {
  const latest = new Map<string, ResultRow>();
  for (const f of files) {
    for (const r of readRows(f)) {
      if (r.error || !r.lab) continue;
      latest.set(keyOf(r), r); // files are oldest first, so later runs win
    }
  }
  return latest;
}

/** Each page's recent successful results (per strategy), oldest first, at most `keep`. */
export function recentByPage(files: string[], keep = 3): Map<string, ResultRow[]> {
  const recent = new Map<string, ResultRow[]>();
  for (const f of files) {
    for (const r of readRows(f)) {
      if (r.error || !r.lab) continue;
      const k = keyOf(r);
      const list = recent.get(k) ?? [];
      list.push(r);
      if (list.length > keep) list.shift();
      recent.set(k, list);
    }
  }
  return recent;
}
