import { test } from "node:test";
import assert from "node:assert/strict";
import { minutesThisMonth } from "../src/github.ts";

test("minutes this month: finished runs from GitHub plus the run in progress, skipped runs ignored", async () => {
  process.env.GITHUB_TOKEN = "t";
  process.env.GITHUB_REPOSITORY = "o/r";
  const runs = [
    { id: 1, status: "completed", conclusion: "success", run_started_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:52:10Z" },
    { id: 2, status: "completed", conclusion: "skipped", run_started_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:00:02Z" },
    { id: 3, status: "in_progress", run_started_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:01:00Z" },
  ];
  const fetcher = (async () => new Response(JSON.stringify({ workflow_runs: runs }))) as typeof fetch;
  assert.equal(await minutesThisMonth(new Date("2026-11-05T10:57:00Z"), "3", 57 * 60_000, fetcher), 53 + 57);
  delete process.env.GITHUB_TOKEN;
  assert.equal(await minutesThisMonth(new Date(), "3", 0, fetcher), null);
});
