import type { CDPSession } from "playwright-core";

/** Bind Playwright's generated CDP sender while preserving its protocol types. */
export function bindPlaywrightCdpSend(session: CDPSession): CDPSession["send"] {
  return session.send.bind(session);
}
