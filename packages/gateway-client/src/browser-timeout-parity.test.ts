import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS as browserRequestTimeoutMs,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS as browserPreauthTimeoutMs,
  resolveSafeTimeoutDelayMs as resolveBrowserTimeoutDelayMs,
} from "./browser.js";
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  resolveSafeTimeoutDelayMs,
} from "./timeouts.js";

describe("browser timeout export parity", () => {
  it("matches the dedicated timeout entrypoint", () => {
    expect(browserRequestTimeoutMs).toBe(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(browserPreauthTimeoutMs).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    for (const [delayMs, options] of [
      [Number.NaN, undefined],
      [-1, undefined],
      [0, { minMs: 0 }],
      [250, { minMs: 500 }],
      [Number.POSITIVE_INFINITY, { minMs: 10 }],
    ] as const) {
      expect(resolveBrowserTimeoutDelayMs(delayMs, options)).toBe(
        resolveSafeTimeoutDelayMs(delayMs, options),
      );
    }
  });
});
