import { chromium } from "playwright-core";

/** Test transport that preserves the existing Playwright connection spies. */
export function connectOverCdpTransport(
  connectionUrl: string,
  opts: { timeout: number; headers: Record<string, string> },
) {
  return chromium.connectOverCDP(connectionUrl, {
    timeout: opts.timeout,
    headers: opts.headers,
  });
}
