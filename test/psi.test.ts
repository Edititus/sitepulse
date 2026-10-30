import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RateLimiter, runTest, summarize } from "../src/psi.ts";
import { passes } from "../src/report.ts";

const thresholds = { lcp_ms: 2500, cls: 0.1, tbt_ms: 200, inp_ms: 200 };

const sample = {
  loadingExperience: {
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100 },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 },
    },
    overall_category: "AVERAGE",
  },
  lighthouseResult: {
    lighthouseVersion: "12.6.0",
    categories: { performance: { score: 0.58 } },
    audits: {
      "largest-contentful-paint": { numericValue: 4210.7 },
      "cumulative-layout-shift": { numericValue: 0.0213 },
      "total-blocking-time": { numericValue: 350.2 },
      "first-contentful-paint": { numericValue: 1800 },
      "speed-index": { numericValue: 3900 },
      "total-byte-weight": { numericValue: 2400000 },
      "largest-contentful-paint-element": {
        details: { type: "list", items: [{ type: "table", items: [{ node: { snippet: '<img class="hero">' } }] }] },
      },
      "render-blocking-resources": { details: { items: [{ url: "https://x.com/a.css", wastedMs: 420.4 }] } },
      "third-party-summary": {
        details: {
          items: [
            { entity: { text: "Google Tag Manager" }, blockingTime: 90, transferSize: 120000 },
            { entity: "HubSpot", blockingTime: 300, transferSize: 80000 },
          ],
        },
      },
    },
  },
};

test("summarize keeps the useful numbers", () => {
  const s = summarize(sample);
  assert.equal(s.score, 58);
  assert.deepEqual(s.lab, { lcp_ms: 4211, cls: 0.021, tbt_ms: 350, fcp_ms: 1800, si_ms: 3900, bytes: 2400000 });
  assert.deepEqual(s.field, { lcp_ms: 3100, inp_ms: 180, cls: 0.05, category: "AVERAGE", origin_fallback: false });
  assert.equal(s.origin_field, null);
  assert.equal(s.hints.lcp_element?.snippet, '<img class="hero">');
  assert.deepEqual(s.hints.render_blocking, [{ url: "https://x.com/a.css", wasted_ms: 420 }]);
  assert.equal(s.hints.third_parties[0].name, "HubSpot", "sorted by blocking time");
  assert.equal(passes(s, thresholds), false);
});

test("summarize survives an empty response", () => {
  const s = summarize({});
  assert.equal(s.score, null);
  assert.equal(passes(s, thresholds), null);
});

test("summarize reads a real Lighthouse 13 report", () => {
  // Generated locally with Lighthouse 13.6 against a test page with a blocking script and CSS.
  const lhr = JSON.parse(readFileSync("test/fixtures/lighthouse.json", "utf8"));
  const s = summarize({ lighthouseResult: lhr });
  assert.equal(s.lighthouse, "13.6.0");
  assert.equal(typeof s.score, "number");
  assert.equal(typeof s.lab.lcp_ms, "number");
  assert.equal(s.lab.cls, 0);
  assert.equal(typeof s.lab.tbt_ms, "number");
  assert.equal(s.hints.lcp_element?.selector, "body > h1");
  assert.equal(s.hints.lcp_element?.label, "Hello");
  assert.equal(typeof s.hints.lcp_breakdown.timeToFirstByte, "number");
  assert.deepEqual(s.hints.render_blocking.map((r) => r.url.split("/").pop()), ["b.js", "a.css"]);
});

test("runTest retries a server error, then succeeds, and never leaks the key", async () => {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    assert.ok(String(url).includes("key=SECRET"));
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "Lighthouse failed" } }), { status: 500 });
    return new Response(JSON.stringify(sample), { status: 200 });
  }) as typeof fetch;
  const r = await runTest("https://g.com/", "SECRET", "mobile", new RateLimiter(30), { fetcher, backoffMs: 1 });
  assert.equal(calls, 2);
  assert.equal(r.error, null);
  assert.equal(r.summary?.score, 58);
});

test("runTest gives up on a bad key without retrying", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 });
  }) as typeof fetch;
  const r = await runTest("https://g.com/", "SECRET", "mobile", new RateLimiter(30), { fetcher, backoffMs: 1 });
  assert.equal(calls, 1);
  assert.equal(r.summary, null);
  assert.match(r.error!, /HTTP 400: API key not valid/);
  assert.ok(!r.error!.includes("SECRET"));
});

test("rate limiter never allows more than the limit within a minute", async () => {
  const limiter = new RateLimiter(3, 1000);
  const t0 = Date.now();
  await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
  assert.ok(Date.now() - t0 < 500, "first three start immediately");
  let fourthStarted = false;
  const fourth = limiter.wait().then(() => (fourthStarted = true));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fourthStarted, false, "fourth waits for the window");
  await fourth;
  assert.ok(Date.now() - t0 >= 1000, "fourth starts only after the window passes");
});
