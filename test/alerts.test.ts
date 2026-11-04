import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlertMessage, buildBaseline, confirm, detect, explainCauses, isSuspicious, type Alert } from "../src/alerts.ts";
import { latestByPage, recentByPage, runFiles } from "../src/history.ts";
import { buildWeekly, latestIncludingErrors } from "../src/weekly.ts";
import { summarize } from "../src/psi.ts";
import type { ResultRow } from "../src/report.ts";

const t = { lcp_ms: 2500, cls: 0.1, tbt_ms: 200, inp_ms: 200 };

function row(over: Partial<ResultRow> & { lcp?: number; tbt?: number; cls?: number; hosts?: string[] } = {}): ResultRow {
  const { lcp = 4000, tbt = 300, cls = 0.02, hosts, ...rest } = over;
  return {
    run_id: "2026-11-03_0417", site: "D1CU", url: "https://d.com/uni/a", reason: "rotation", strategy: "mobile", error: null,
    score: 50, pass: false,
    lab: { lcp_ms: lcp, cls, tbt_ms: tbt, fcp_ms: 1000, si_ms: 3000, bytes: 1_000_000 },
    hints: { lcp_element: { label: "Hero", selector: "div.hero > img", snippet: "<img>" }, lcp_breakdown: { timeToFirstByte: 200, elementRenderDelay: 1800 }, render_blocking: [{ url: "https://d.com/theme/main.css", wasted_ms: 600 }], third_parties: [{ name: "HubSpot", blocking_ms: 400, bytes: 100 }] },
    ...(hosts ? { scripts: { hosts, count: hosts.length, bytes: 1000 } } : {}),
    ...rest,
  } as ResultRow;
}
const base = (...rs: ResultRow[]) => buildBaseline(rs)!;

test("baseline is the median of recent results and needs at least 2 of them", () => {
  assert.equal(buildBaseline([row()]), undefined);
  assert.equal(buildBaseline(undefined), undefined);
  const b = base(row({ lcp: 3000 }), row({ lcp: 9000 }), row({ lcp: 3500 }));
  assert.equal(b.lab!.lcp_ms, 3500, "one bad day doesn't move the baseline");
  assert.equal(base(row({ lcp: 3000 }), row({ lcp: 120_000 }), row({ lcp: 3400 })).lab!.lcp_ms, 3200, "over-60 s results are left out");
  const blockPage = row({ lcp: 800, hints: { ...row().hints!, lcp_element: { label: "You’ve been blocked for security reasons", selector: "h1", snippet: "<h1>" } } });
  assert.equal(base(row({ lcp: 6000 }), blockPage, row({ lcp: 6400 })).lab!.lcp_ms, 6200, "old block-page results are left out");
  assert.equal(base(row({ pass: true }), row({ pass: true }), row({ pass: false })).pass, true);
  assert.equal(base(row({ pass: true }), row({ pass: false })).pass, false);
});

test("normal day-to-day swings never alert", () => {
  const b = base(row({ lcp: 4000 }), row({ lcp: 4200 }));
  assert.deepEqual(detect(row({ lcp: 7800 }), b, t).kinds, [], "1.9x is within normal swing");
  assert.deepEqual(detect(row({ lcp: 3000 }), base(row({ lcp: 1000 }), row({ lcp: 1000 })), t).kinds, [], "3x but only 2 s");
  assert.deepEqual(detect(row({ tbt: 1100 }), base(row({ tbt: 300 }), row({ tbt: 300 })), t).kinds, [], "TBT 3.7x");
  assert.deepEqual(detect(row(), undefined, t).kinds, []);
});

test("a clearly slower page alerts", () => {
  const b = base(row({ lcp: 3100 }), row({ lcp: 3000 }), row({ lcp: 3200 }));
  const d = detect(row({ lcp: 6400 }), b, t);
  assert.deepEqual(d.kinds, ["slower"]);
  assert.equal(d.changes[0], "Main content shows: usually 3.1 s, now 6.4 s");
  assert.deepEqual(detect(row({ tbt: 2000 }), base(row({ tbt: 300 }), row({ tbt: 300 })), t).kinds, ["slower"]);
  assert.deepEqual(detect(row({ cls: 0.25 }), base(row({ cls: 0.02 }), row({ cls: 0.02 })), t).kinds, ["slower"]);
});

test("a new script source alerts only if it was never seen in recent results", () => {
  const b = base(row({ hosts: ["d.com", "ads.com"] }), row({ hosts: ["d.com"] }));
  assert.deepEqual(detect(row({ hosts: ["d.com", "ads.com"] }), b, t).kinds, [], "seen before on one of the days");
  const d = detect(row({ hosts: ["d.com", "meetings.hubspot.com"] }), b, t);
  assert.deepEqual(d.kinds, ["new-script"]);
  assert.deepEqual(d.newHosts, ["meetings.hubspot.com"]);
  assert.deepEqual(detect(row({ hosts: ["d.com", "x.com"] }), base(row({ hosts: ["d.com"] }), row()), t).kinds, [], "older results without a script list");
});

test("a page that usually passes and now fails alerts", () => {
  assert.deepEqual(detect(row({ pass: false }), base(row({ pass: true }), row({ pass: true })), t).kinds, ["now-failing"]);
});

test("results over 60 s are 'needs a look', never 'slower'", () => {
  assert.equal(isSuspicious(row({ lcp: 95_000 })), true);
  assert.deepEqual(detect(row({ lcp: 95_000 }), base(row(), row()), t).kinds, []);
});

test("all three tests must agree, and the fastest test's numbers are reported", () => {
  const b = base(row({ lcp: 3100, hosts: ["d.com"] }), row({ lcp: 3100, hosts: ["d.com"] }));
  const tests = [row({ lcp: 9000, hosts: ["d.com", "x.com"] }), row({ lcp: 7000, hosts: ["d.com", "x.com"] }), row({ lcp: 3300, hosts: ["d.com", "x.com"] })];
  const ds = tests.map((r) => detect(r, b, t));
  const result = confirm(ds, ds[2]);
  assert.deepEqual(result.kinds, ["new-script"], "slowness disappeared on the third test; the new script is real");
  const slow = [row({ lcp: 9000 }), row({ lcp: 7000 }), row({ lcp: 6800 })].map((r) => detect(r, b, t));
  const confirmed = confirm(slow, slow[2]);
  assert.deepEqual(confirmed.kinds, ["slower"]);
  assert.equal(confirmed.changes[0], "Main content shows: usually 3.1 s, now 6.8 s");
});

test("causes are plain English, most specific first, and don't quote mismatched seconds", () => {
  const b = base(row({ lcp: 3100, hosts: ["d.com"] }), row({ lcp: 3100, hosts: ["d.com"] }));
  const now = row({ lcp: 6400, hosts: ["d.com", "calendly.com"] });
  const causes = explainCauses(now, b, detect(now, b, t));
  assert.equal(causes[0], "A new script is loading from calendly.com");
  assert.equal(causes[1], 'Most of the wait (90%) is the main element ("Hero") being ready but not shown yet, usually because scripts or styles block it');
  assert.equal(causes[2], "Biggest blocking file: d.com/…/main.css");
});

test("a new-script-only alert doesn't add unrelated loading causes", () => {
  const b = base(row({ hosts: ["d.com"] }), row({ hosts: ["d.com"] }));
  const now = row({ hosts: ["d.com", "calendly.com"] });
  assert.deepEqual(explainCauses(now, b, detect(now, b, t)), ["A new script is loading from calendly.com"]);
});

test("alert message groups pages from the same template", () => {
  const mk = (url: string): Alert => ({ site: "D1CU", url, template: "/uni/*", kinds: ["slower"], changes: ["Main content shows: usually 3.1 s, now 6.4 s"], causes: ["x"], prevRunId: "2026-10-27_0417" });
  const msg = buildAlertMessage([mk("https://d.com/uni/a"), mk("https://d.com/uni/b"), { ...mk("https://d.com/about"), template: "/about" }], "4 Nov 2026", { "2026-10-27_0417": "27 Oct" })!;
  assert.match(msg, /^SitePulse alert: 3 pages got worse \(4 Nov 2026, confirmed by 3 tests\)/);
  assert.match(msg, /1\. D1CU template \/uni\/\*: 2 pages/);
  assert.match(msg, /2\. D1CU \/about/);
  assert.match(msg, /Compared with: its usual result \(last tests up to 27 Oct\)/);
  assert.equal(buildAlertMessage([], "x", {}), null);
});

test("history: recent results per page, skipping errors, damaged lines and the current run", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const line = (o: object) => JSON.stringify(o) + "\n";
  writeFileSync(join(dir, "2026-10-31_0517.jsonl"), line(row({ run_id: "2026-10-31_0517", lcp: 2000 })));
  writeFileSync(join(dir, "2026-11-01_0517.jsonl"), line(row({ run_id: "2026-11-01_0517", lcp: 3000 })));
  writeFileSync(join(dir, "2026-11-02_0517.jsonl"), line({ ...row({ run_id: "2026-11-02_0517" }), error: "HTTP 500", lab: undefined }));
  writeFileSync(join(dir, "2026-11-03_0517.jsonl"), line(row({ run_id: "2026-11-03_0517", lcp: 3500 })) + "not json\n" + line(row({ run_id: "2026-11-03_0517", lcp: 4000 })));
  writeFileSync(join(dir, "2026-11-04_0517.jsonl"), line(row({ run_id: "2026-11-04_0517", lcp: 9999 })));
  writeFileSync(join(dir, "2026-11-03_0517-summary.txt"), "ignored");
  const files = runFiles(dir, new Date("2026-11-04T06:00:00Z"), 30, "2026-11-04_0517");
  assert.equal(files.length, 4);
  const recent = [...recentByPage(files, 3).values()][0];
  assert.deepEqual(recent.map((r) => r.lab!.lcp_ms), [3000, 3500, 4000]);
  assert.equal([...latestByPage(files).values()][0].lab!.lcp_ms, 4000);
  assert.equal(runFiles(dir, new Date("2026-12-30T06:00:00Z"), 30).length, 0, "old files drop out");
  assert.match(buildWeekly(latestIncludingErrors(files), "week to 4 Nov 2026"), /^SitePulse weekly report: week to 4 Nov 2026\n1 page tested this week/);
});

test("weekly list separates slow, needs-a-look and untestable pages", () => {
  const rows = [
    row({ url: "https://d.com/a", lcp: 8000 }),
    row({ url: "https://d.com/b", lcp: 120_000 }),
    { ...row({ url: "https://d.com/c" }), error: "HTTP 500: Lighthouse returned error", lab: undefined } as ResultRow,
  ];
  const msg = buildWeekly(rows, "week to 9 Nov 2026");
  assert.match(msg, /1\. D1CU \/a: 8\.0 s/);
  assert.match(msg, /Needs a look: 1 page measured over 60 s[\s\S]*\/b: 120\.0 s \(late element: "Hero"\)/);
  assert.match(msg, /Could not be tested \(1\):\n- D1CU \/c: HTTP 500/);
});

test("script hosts are read from a real Lighthouse 13 report", () => {
  const s = summarize({ lighthouseResult: JSON.parse(readFileSync("test/fixtures/lighthouse.json", "utf8")) });
  assert.deepEqual(s.scripts?.hosts, ["localhost:8765"]);
  assert.equal(s.scripts?.count, 1);
});
