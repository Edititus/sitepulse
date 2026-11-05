import { test } from "node:test";
import assert from "node:assert/strict";
import { hostMatches, loadPlaybook, playbookLines } from "../src/playbook.ts";
import { summarize } from "../src/psi.ts";
import type { Detection } from "../src/alerts.ts";
import type { ResultRow } from "../src/report.ts";

const pb = loadPlaybook("playbook.json")!;

function row(site: string, path: string, over: Partial<ResultRow> = {}): ResultRow {
  return {
    run_id: "r", site, url: `https://x.com${path}`, reason: "one-off", strategy: "mobile", error: null, pass: false, score: 40,
    lab: { lcp_ms: 9000, cls: 0, tbt_ms: 900, fcp_ms: 1, si_ms: 1, bytes: 1 },
    hints: { lcp_element: { label: "Day 1 CPT", selector: "div", snippet: '<div class="section-bg__media" style="background-image: url(x)">' }, lcp_breakdown: { timeToFirstByte: 20, resourceLoadDelay: 900, elementRenderDelay: 300 }, render_blocking: [], third_parties: [{ name: "Facebook", blocking_ms: 600, bytes: 1 }] },
    scripts: { hosts: ["x.com"], count: 1, bytes: 1, frames: [] },
    ...over,
  } as ResultRow;
}
const d = (metrics: Detection["metrics"], newHosts: string[] = []): Detection => ({ kinds: ["slower"], changes: [], newHosts, metrics });

test("the playbook file loads", () => {
  assert.equal(pb.fixes.length, 9);
  assert.ok(pb.avoid.length && pb.known_issues.length);
});

test("a late CSS background banner matches the Head HTML preload fix", () => {
  const lines = playbookLines(pb, row("D1CU", "/westcliff"), d(["lcp"]));
  assert.match(lines[0], /^Similar past fix: Main banner \(CSS background\) found late .*rel="preload"/);
  assert.match(lines[1], /^Watch out: The URL must match the CSS exactly/);
});

test("a calendar embed matches the hidden-calendar fix, with the goelite.com warning", () => {
  const r = row("GE", "/blogs/x", { scripts: { hosts: ["x.com"], count: 1, bytes: 1, frames: ["meetings.hubspot.com"] } });
  const lines = playbookLines(pb, r, { ...d(["tbt"], ["meetings.hubspot.com"]), kinds: ["new-script"] });
  assert.match(lines[0], /Hidden booking calendar/);
  assert.match(lines[1], /^Careful on GE: Lazy-loading Meetings on goelite\.com did not work in July/);
  assert.ok(lines.some((l) => /Known issue: Orphaned blog-meeting pop-up/.test(l)));
});

test("tracker-heavy pages on D1CU get the don't-retry note and the known tracker issue", () => {
  const lines = playbookLines(pb, row("D1CU", "/", { hints: { ...row("D1CU", "/").hints!, lcp_breakdown: { elementRenderDelay: 900 } } }), d(["tbt"]));
  assert.ok(lines.some((l) => /^Don't retry: Delaying marketing trackers .*Christine/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^Known issue: Marketing trackers/.test(l)));
});

test("VD school pages are flagged as a known issue even with no fix match", () => {
  const lines = playbookLines(pb, row("VD", "/schools/monroe-university", { hints: { ...row("VD", "/").hints!, lcp_breakdown: { timeToFirstByte: 900 }, third_parties: [] } }), d(["lcp"]));
  assert.deepEqual(lines, ["Known issue: Very slow VD school pages (Curry College 29.9 s, Monroe 27.1 s, CIAM 22.0 s); follow-on Request."]);
});

test("no playbook file means no lines", () => {
  assert.deepEqual(playbookLines(null, row("D1CU", "/"), d(["lcp"])), []);
});

test("embedded frames are recorded from the network requests", () => {
  const s = summarize({ lighthouseResult: { finalDisplayedUrl: "https://d.com/", audits: { "network-requests": { details: { items: [
    { url: "https://d.com/", resourceType: "Document" },
    { url: "https://meetings.hubspot.com/d1cu?embed=true", resourceType: "Document" },
    { url: "https://d.com/other-page", resourceType: "Document" },
    { url: "https://static.hsappstatic.net/x/project.js", resourceType: "Script", transferSize: 5000 },
  ] } } } } });
  assert.deepEqual(s.scripts, { hosts: ["static.hsappstatic.net"], count: 1, bytes: 5000, frames: ["meetings.hubspot.com"] });
});

test("host patterns match regional subdomains", () => {
  assert.equal(hostMatches("js-na2.usemessages.com", "usemessages.com"), true);
  assert.equal(hostMatches("usemessages.com", "usemessages.com"), true);
  assert.equal(hostMatches("notusemessages.com", "usemessages.com"), false);
});

test("chat that already loads everywhere is not blamed; chat that is NEW is", () => {
  const withChat = row("D1CU", "/x", { scripts: { hosts: ["js-na2.usemessages.com"], count: 1, bytes: 1, frames: [] }, hints: { ...row("D1CU", "/").hints!, lcp_breakdown: { elementRenderDelay: 900 }, third_parties: [] } });
  assert.ok(!playbookLines(pb, withChat, d(["tbt"])).some((l) => /Live chat/.test(l)));
  const lines = playbookLines(pb, withChat, { ...d(["tbt"], ["js-na2.usemessages.com"]), kinds: ["new-script", "slower"] });
  assert.match(lines[0], /^Similar past fix: Live chat loading on page open \(the deferral may have stopped working\)/);
  assert.match(lines[1], /config line must come before the loader/);
});

test("a heavy banner gets the WebP advice, not the preload", () => {
  const r = row("D1CU", "/x", { hints: { ...row("D1CU", "/").hints!, lcp_breakdown: { resourceLoadDuration: 2000, resourceLoadDelay: 100 } } });
  assert.match(playbookLines(pb, r, d(["lcp"]))[0], /^Similar past fix: Main banner file too heavy/);
});

test("banner fixes only match when load time got worse, not script freezing", () => {
  const r = row("D1CU", "/x", { hints: { ...row("D1CU", "/").hints!, third_parties: [] } });
  assert.match(playbookLines(pb, r, d(["lcp"]))[0] ?? "", /Main banner/);
  assert.ok(!playbookLines(pb, r, d(["tbt"])).some((l) => /Main banner/.test(l)));
  assert.match(playbookLines(pb, r, { kinds: ["now-failing"], changes: [], newHosts: [], metrics: [] })[0] ?? "", /Main banner/);
});
