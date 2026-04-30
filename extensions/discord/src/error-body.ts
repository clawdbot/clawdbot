const DISCORD_RESPONSE_BODY_SUMMARY_MAX_CHARS = 240;

export function summarizeDiscordResponseBody(
  body: string,
  opts: { emptyText?: string } = {},
): string | undefined {
  const summary = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) {
    return opts.emptyText;
  }
  return summary.slice(0, DISCORD_RESPONSE_BODY_SUMMARY_MAX_CHARS);
}

export function isDiscordHtmlResponseBody(body: string, contentType?: string | null): boolean {
  return (
    /\bhtml\b/i.test(contentType ?? "") ||
    /^\s*<!doctype\s+html\b/i.test(body) ||
    /^\s*<html\b/i.test(body)
  );
}

export function isDiscordRateLimitResponseBody(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    normalized.includes("error 1015") ||
    normalized.includes("cloudflare") ||
    normalized.includes("rate limit")
  );
}
