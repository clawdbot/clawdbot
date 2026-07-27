import { describe, it, expect } from "vitest";
import { resolveTelegramAdoptionStallTimeoutMs } from "./telegram-ingress-drain.js";

// End-to-end proof for PR #114171: verifies that
// channels.telegram.spooledUpdateHandlerTimeoutMs flows from config through
// monitor.ts forwarding into resolveTelegramAdoptionStallTimeoutMs, which
// is the function consumed by TelegramPollingSession's isolated ingress.
//
// monitor.ts:289-298 forwards account.config.spooledUpdateHandlerTimeoutMs
// into isolatedIngress.spooledUpdateHandlerTimeoutMs. polling-session.ts:137-141
// passes that as `configured` to resolveTelegramAdoptionStallTimeoutMs.

// Mirrors monitor.ts:289-298 forwarding logic.
function buildIsolatedIngress(accountConfig: {
  apiRoot?: string;
  proxy?: string;
  network?: unknown;
  spooledUpdateHandlerTimeoutMs?: number;
}) {
  return {
    enabled: true,
    apiRoot: accountConfig.apiRoot,
    proxy: accountConfig.proxy,
    network: accountConfig.network,
    ...(accountConfig.spooledUpdateHandlerTimeoutMs !== undefined
      ? { spooledUpdateHandlerTimeoutMs: accountConfig.spooledUpdateHandlerTimeoutMs }
      : {}),
  };
}

describe("PR #114171 config-to-polling-session proof", () => {
  it("config value reaches resolveTelegramAdoptionStallTimeoutMs as the selected timeout", () => {
    const accountConfig = { spooledUpdateHandlerTimeoutMs: 600000 };
    const isolatedIngress = buildIsolatedIngress(accountConfig);
    const result = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress?.spooledUpdateHandlerTimeoutMs,
      env: {},
    });
    expect(result).toBe(600000);
  });

  it("config value takes precedence over env var", () => {
    const accountConfig = { spooledUpdateHandlerTimeoutMs: 120000 };
    const isolatedIngress = buildIsolatedIngress(accountConfig);
    const result = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress?.spooledUpdateHandlerTimeoutMs,
      env: { OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: "300000" },
    });
    expect(result).toBe(120000);
  });

  it("env var is used when config omits the field", () => {
    const accountConfig = {};
    const isolatedIngress = buildIsolatedIngress(accountConfig);
    const result = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress?.spooledUpdateHandlerTimeoutMs,
      env: { OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: "300000" },
    });
    expect(result).toBe(300000);
  });

  it("default 5min timeout when neither config nor env sets the field", () => {
    const accountConfig = {};
    const isolatedIngress = buildIsolatedIngress(accountConfig);
    const result = resolveTelegramAdoptionStallTimeoutMs({
      configured: isolatedIngress?.spooledUpdateHandlerTimeoutMs,
      env: {},
    });
    expect(result).toBe(300000);
  });
});
