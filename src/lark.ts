// Send a message to the SitePulse Lark group through its custom-bot webhook.

type Fetch = typeof fetch;

export async function sendText(webhookUrl: string, text: string, fetcher: Fetch = fetch) {
  // The bot only accepts messages containing its keyword.
  if (!text.includes("SitePulse")) text = "SitePulse\n" + text;
  const res = await fetcher(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(30_000),
  });
  const reply: any = await res.json().catch(() => ({}));
  // Lark answers HTTP 200 even on failure; the real result is in "code".
  const code = reply.code ?? reply.StatusCode ?? (res.ok ? 0 : res.status);
  if (code !== 0) throw new Error(`Lark rejected the message: code ${code} ${reply.msg ?? ""}`.trim());
  return reply;
}
