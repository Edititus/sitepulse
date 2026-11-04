// How many GitHub Actions minutes SitePulse has used this month (private repos get 2,000 free).
// Best effort: if anything fails, the summary simply leaves the line out.

type Fetch = typeof fetch;

export async function minutesThisMonth(now = new Date(), fetcher: Fetch = fetch): Promise<number | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  if (!token || !repo) return null;
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  try {
    let total = 0;
    for (let page = 1; page <= 5; page++) {
      const res = await fetcher(
        `${api}/repos/${repo}/actions/workflows/sitepulse.yml/runs?created=>=${monthStart}&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return null;
      const body: any = await res.json();
      const runs: any[] = body.workflow_runs ?? [];
      for (const r of runs) {
        const start = Date.parse(r.run_started_at ?? r.created_at);
        const end = r.status === "completed" ? Date.parse(r.updated_at) : now.getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) total += Math.ceil((end - start) / 60_000);
      }
      if (runs.length < 100) break;
    }
    return total;
  } catch {
    return null;
  }
}
