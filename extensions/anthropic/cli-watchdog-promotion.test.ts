// Real-behavior proof for the resume-watchdog promotion fix (#125045).
// Kept in a focused file so cli-shared.test.ts stays under the max-lines budget.
import { resolveCliNoOutputTimeoutMs } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

describe("Claude CLI backend descriptor watchdog defaults (#125045)", () => {
  it("does not ship stock watchdog defaults that disable resume-watchdog promotion", () => {
    // The descriptor must not spread CLI_FRESH/RESUME_WATCHDOG_DEFAULTS into
    // config.reliability.watchdog. Those copies are byte-identical to the
    // fallback pickWatchdogProfile already uses, so shipping them only makes
    // `configured` always truthy, which permanently disables the promotion
    // gate (!configured) and pins resumed cron/explicit-timeout turns to the
    // 180s resume no-output ceiling instead of the 600s fresh ceiling.
    const { config } = buildAnthropicCliBackend();
    expect(config.reliability?.watchdog).toBeUndefined();
  });

  it("promotes resumed cron turns to the fresh no-output budget via the real resolver", () => {
    // Real-behavior proof: drive the shipped descriptor config (no reliability.watchdog
    // block post-fix) through the production resolver that pickWatchdogProfile backs.
    // Pre-fix the descriptor shipped byte-identical resume defaults, so `configured` was
    // truthy, the !configured promotion gate was dead, and a resumed cron turn stayed on
    // the 180s resume ceiling. Post-fix the block is gone, promotion is live, and the
    // resolver returns the fresh 480000 budget (600000 * 0.8) for a resumed cron turn.
    const { config } = buildAnthropicCliBackend();
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: config,
      timeoutMs: 600_000,
      useResume: true,
      trigger: "cron",
    });
    expect(timeoutMs).toBe(480_000);
  });
});
