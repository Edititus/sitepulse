import { test } from "node:test";
import assert from "node:assert/strict";
import { applyExcludes, fetchSitemapUrls, parseSitemap, selectPages, templateKey } from "../src/pages.ts";

test("parses a page sitemap and a sitemap index", () => {
  const pages = parseSitemap(`<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc> https://a.com/ </loc></url></urlset>`);
  assert.deepEqual(pages, { pages: ["https://a.com/x?a=1&b=2", "https://a.com/"], children: [] });
  const index = parseSitemap(`<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual(index, { pages: [], children: ["https://a.com/s1.xml"] });
});

test("follows sitemap indexes and removes duplicates", async () => {
  const files: Record<string, string> = {
    "https://a.com/sitemap.xml": `<sitemapindex><sitemap><loc>https://a.com/1.xml</loc></sitemap><sitemap><loc>https://a.com/2.xml</loc></sitemap></sitemapindex>`,
    "https://a.com/1.xml": `<urlset><url><loc>https://a.com/a</loc></url></urlset>`,
    "https://a.com/2.xml": `<urlset><url><loc>https://a.com/a</loc></url><url><loc>https://a.com/b</loc></url></urlset>`,
  };
  const urls = await fetchSitemapUrls("https://a.com/sitemap.xml", async (u) => files[u]);
  assert.deepEqual(urls, ["https://a.com/a", "https://a.com/b"]);
});

test("excludes Chinese pages but keeps similar-looking paths", () => {
  const urls = ["https://g.com/zh", "https://g.com/zh/blogs/x", "https://g.com/zhang", "https://g.com/blogs/zh"];
  assert.deepEqual(applyExcludes(urls, ["^/zh(/|$)"]), ["https://g.com/zhang", "https://g.com/blogs/zh"]);
});

test("groups pages by template", () => {
  assert.equal(templateKey("https://g.com/"), "/");
  assert.equal(templateKey("https://g.com/about-us"), "/about-us");
  assert.equal(templateKey("https://g.com/blogs/post-1"), "/blogs/*");
  assert.equal(templateKey("https://g.com/a/b/c"), "/a/b/*");
});

test("daily selection: one-offs every day, every template page once a week", () => {
  const oneOffs = ["/", "/about-us", "/contact"].map((p) => "https://g.com" + p);
  const blogs = Array.from({ length: 70 }, (_, i) => `https://g.com/blogs/post-${i}`);
  const urls = [...oneOffs, ...blogs];
  const seen = new Set<string>();
  for (let day = 100; day < 107; day++) {
    const picked = selectPages(urls, { dayNumber: day });
    for (const u of oneOffs) assert.ok(picked.some((p) => p.url === u), `one-off ${u} missing on day ${day}`);
    const samples = picked.filter((p) => p.reason === "template-sample");
    assert.equal(samples.length, 2);
    assert.ok(picked.length < urls.length / 2, "daily selection should be much smaller than all pages");
    picked.forEach((p) => seen.add(p.url));
  }
  assert.equal(seen.size, urls.length, "every page is tested at least once in 7 days");
});

test("full mode returns every page", () => {
  const urls = ["https://g.com/a", "https://g.com/blogs/1"];
  assert.equal(selectPages(urls, { dayNumber: 1, mode: "full" }).length, 2);
});
