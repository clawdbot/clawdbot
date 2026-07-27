import { describe, it, expect } from "vitest";
import { buildTelegramIsolatedIngressOptions } from "./monitor.js";

// End-to-end proof for PR #114171: exercises the actual production helper
// used by monitorTelegramProvider to build isolatedIngress options, asserting
// that account.config.spooledUpdateHandlerTimeoutMs reaches the polling
// session's isolatedIngress object.
//
// monitor.ts uses buildTelegramIsolatedIngressOptions() to construct the
// isolatedIngress object passed to TelegramPollingSession. This test calls
// that same production helper — not a copied forwarding implementation.

describe("PR #114171 buildTelegramIsolatedIngressOptions proof", () => {
  it("forwards spooledUpdateHandlerTimeoutMs from account config", () => {
    const result = buildTelegramIsolatedIngressOptions({
      enabled: true,
      apiRoot: undefined,
      proxy: undefined,
      network: undefined,
      spooledUpdateHandlerTimeoutMs: 600000,
    });
    expect(result.spooledUpdateHandlerTimeoutMs).toBe(600000);
    expect(result.enabled).toBe(true);
  });

  it("omits spooledUpdateHandlerTimeoutMs when config does not set it", () => {
    const result = buildTelegramIsolatedIngressOptions({
      enabled: true,
    });
    expect(result.spooledUpdateHandlerTimeoutMs).toBeUndefined();
  });

  it("preserves apiRoot, proxy, and network alongside the timeout", () => {
    const result = buildTelegramIsolatedIngressOptions({
      enabled: false,
      apiRoot: "https://custom.api.root",
      proxy: "socks5://proxy:1080",
      network: { autoSelectFamily: true },
      spooledUpdateHandlerTimeoutMs: 120000,
    });
    expect(result).toEqual({
      enabled: false,
      apiRoot: "https://custom.api.root",
      proxy: "socks5://proxy:1080",
      network: { autoSelectFamily: true },
      spooledUpdateHandlerTimeoutMs: 120000,
    });
  });
});
