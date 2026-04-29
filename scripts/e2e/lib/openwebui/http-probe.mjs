const [url, expectedRaw = "200"] = process.argv.slice(2);
if (!url) {
  throw new Error("usage: http-probe.mjs <url> [status|lt500]");
}

const timeoutMs = Number(process.env.OPENCLAW_HTTP_PROBE_TIMEOUT_MS ?? 30_000);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  const headers = {};
  if (process.env.OPENCLAW_HTTP_PROBE_BEARER) {
    headers.authorization = `Bearer ${process.env.OPENCLAW_HTTP_PROBE_BEARER}`;
  }
  const res = await fetch(url, { headers, signal: controller.signal }).catch(() => null);
  const ok =
    expectedRaw === "lt500"
      ? Boolean(res && res.status < 500)
      : res?.status === Number(expectedRaw);
  process.exit(ok ? 0 : 1);
} finally {
  clearTimeout(timer);
}
