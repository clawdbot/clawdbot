// HTTP probe for OpenWebUI E2E scenarios.
import { pathToFileURL } from "node:url";
import { readPositiveIntEnv } from "../env-limits.mjs";

const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

function parseExpectedStatus(raw) {
  if (!/^[1-5]\d\d$/u.test(raw)) {
    throw new Error(`expected status must be lt500 or a decimal HTTP status. Got: ${raw}`);
  }
  return Number(raw);
}

function resolveTimerTimeoutMs(valueMs, fallbackMs) {
  const value = Number.isFinite(valueMs) ? valueMs : fallbackMs;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMER_TIMEOUT_MS);
}

export async function probeHttpStatus({
  url,
  expectedRaw = "200",
  timeoutMs = 30_000,
  bearer = "",
  fetchImpl = fetch,
}) {
  if (!url) {
    throw new Error("usage: http-probe.mjs <url> [status|lt500]");
  }
  const expectedStatus = expectedRaw === "lt500" ? undefined : parseExpectedStatus(expectedRaw);
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  let res;
  const headers = {};
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }

  try {
    res = await fetchImpl(url, { headers, signal: controller.signal }).catch(() => null);
    return expectedRaw === "lt500"
      ? Boolean(res && res.status < 500)
      : res?.status === expectedStatus;
  } finally {
    clearTimeout(timer);
    await res?.body?.cancel?.().catch(() => undefined);
  }
}

async function main() {
  const [url, expectedRaw = "200"] = process.argv.slice(2);
  const ok = await probeHttpStatus({
    url,
    expectedRaw,
    timeoutMs: readPositiveIntEnv("OPENCLAW_HTTP_PROBE_TIMEOUT_MS", 30_000),
    bearer: process.env.OPENCLAW_HTTP_PROBE_BEARER,
  });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
