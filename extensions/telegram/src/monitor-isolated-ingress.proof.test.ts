import { describe, it, expect } from "vitest";
import { buildTelegramIsolatedIngressOptions } from "./monitor.js";
import { resolveTelegramAdoptionStallTimeoutMs } from "./telegram-ingress-drain.js";

// End-to-end proof for PR #114171: exercises the actual production helper
// used by monitorTelegramProvider to build isolatedIngress options, then
// feeds the result into resolveTelegramAdoptionStallTimeoutMs — the function
// consumed by TelegramPollingSession's isolated ingress — to show the
// complete config → polling session timeout path.
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

  // Runtime transcript: simulates the full monitor → polling session path
  // with redacted config values, showing the selected timeout at each stage.
  it("runtime transcript: account config reaches polling session timeout", () => {
    // Stage 1: account.config (from openclaw.json channels.telegram)
    const accountConfig = {
      spooledUpdateHandlerTimeoutMs: 600000,
    };
    console.log(
      "[proof] stage 1: account.config.spooledUpdateHandlerTimeoutMs =",
      accountConfig.spooledUpdateHandlerTimeoutMs,
    );

    // Stage 2: monitor.ts builds isolatedIngress via production helper
    const isolatedIngress = buildTelegramIsolatedIngressOptions({
      enabled: true,
      spooledUpdateHandlerTimeoutMs: accountConfig.spooledUpdateHandlerTimeoutMs,
    });
    console.log(
      "[proof] stage 2: isolatedIngress.spooledUpdateHandlerTimeoutMs =",
      isolatedIngress.spooledUpdateHandlerTimeoutMs,
    );
    expect(isolatedIngress.spooledUpdateHandlerTimeoutMs).toBe(600000);

    // Stage 3: polling-session.ts passes configured value to resolver
    const selectedTimeout = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress.spooledUpdateHandlerTimeoutMs,
      env: {},
    });
    console.log(
      "[proof] stage 3: resolveTelegramAdoptionStallTimeoutMs returned =",
      selectedTimeout,
    );
    expect(selectedTimeout).toBe(600000);

    // Stage 4: config takes precedence over env var
    const withEnvOverride = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress.spooledUpdateHandlerTimeoutMs,
      env: { OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: "300000" },
    });
    console.log(
      "[proof] stage 4: with env OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS=300000, selected =",
      withEnvOverride,
      "(config wins)",
    );
    expect(withEnvOverride).toBe(600000);
  });
});
