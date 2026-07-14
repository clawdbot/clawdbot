import { describe, expect, it } from "vitest";
import {
  createGatewayStartupOutcomeRecorder,
  formatGatewayStartupOutcomes,
} from "./server-startup-outcomes.js";

type GatewayStartupOutcomeRecorderParams = Parameters<
  typeof createGatewayStartupOutcomeRecorder
>[0];
type GatewayStartupOutcome = Parameters<typeof formatGatewayStartupOutcomes>[0][number];

const inactiveParams: GatewayStartupOutcomeRecorderParams = {
  cfg: {},
  gatewayStartHooks: false,
  memoryStartupMode: "off",
  env: {},
};

describe("gateway startup outcomes", () => {
  it("formats reverse input in canonical subsystem order", () => {
    const outcomes: GatewayStartupOutcome[] = [
      { subsystem: "gmail-model", status: "scheduled" },
      { subsystem: "gmail-watcher", status: "skipped", reason: "no-gmail-account" },
      { subsystem: "memory-qmd", status: "skipped", reason: "startup-disabled" },
      { subsystem: "gateway-start-hooks", status: "scheduled" },
      { subsystem: "internal-startup-hook", status: "scheduled" },
      { subsystem: "internal-hooks", status: "loaded" },
    ];

    expect(formatGatewayStartupOutcomes(outcomes)).toBe(
      "gateway startup outcomes: internal-hooks=loaded; " +
        "internal-startup-hook=scheduled; gateway-start-hooks=scheduled; " +
        "memory-qmd=skipped (startup-disabled); " +
        "gmail-watcher=skipped (no-gmail-account); gmail-model=scheduled",
    );
  });

  it.each([
    {
      name: "unconfigured",
      params: inactiveParams,
      expected: [
        "internal-hooks=skipped (not-configured)",
        "internal-startup-hook=skipped (no-handlers-loaded)",
        "gateway-start-hooks=skipped (no-handlers-loaded)",
        "memory-qmd=skipped (not-configured)",
        "gmail-watcher=skipped (hooks-disabled)",
        "gmail-model=skipped (not-configured)",
      ],
    },
    {
      name: "explicitly disabled and default-off qmd",
      params: {
        ...inactiveParams,
        cfg: { hooks: { internal: { enabled: false } }, memory: { backend: "qmd" } },
      } satisfies GatewayStartupOutcomeRecorderParams,
      expected: [
        "internal-hooks=skipped (hooks-disabled)",
        "internal-startup-hook=skipped (hooks-disabled)",
        "memory-qmd=skipped (startup-disabled)",
      ],
    },
    {
      name: "scheduled",
      params: {
        cfg: {
          hooks: {
            enabled: true,
            internal: { enabled: true },
            gmail: { account: "operator@example.com", model: "openai/gpt-5.5" },
          },
          memory: { backend: "qmd", qmd: { update: { startup: "immediate" } } },
        },
        gatewayStartHooks: true,
        memoryStartupMode: "immediate",
        env: {},
      } satisfies GatewayStartupOutcomeRecorderParams,
      expected: [
        "internal-hooks=skipped (no-handlers-loaded)",
        "internal-startup-hook=skipped (no-handlers-loaded)",
        "gateway-start-hooks=scheduled",
        "memory-qmd=scheduled",
        "gmail-watcher=scheduled",
        "gmail-model=scheduled",
      ],
    },
    {
      name: "gmail skip reasons",
      params: {
        ...inactiveParams,
        cfg: { hooks: { enabled: true, gmail: { account: "operator@example.com" } } },
        env: { OPENCLAW_SKIP_GMAIL_WATCHER: "1" },
      } satisfies GatewayStartupOutcomeRecorderParams,
      expected: ["gmail-watcher=skipped (disabled-by-environment)"],
    },
    {
      name: "missing gmail account",
      params: {
        ...inactiveParams,
        cfg: { hooks: { enabled: true } },
      } satisfies GatewayStartupOutcomeRecorderParams,
      expected: ["gmail-watcher=skipped (no-gmail-account)"],
    },
  ])("uses the fixed vocabulary for $name", ({ params, expected }) => {
    const summary = formatGatewayStartupOutcomes(
      createGatewayStartupOutcomeRecorder(params).snapshot(),
    );

    for (const entry of expected) {
      expect(summary).toContain(entry);
    }
  });

  it("records awaited internal hook outcomes without logging raw error fields", () => {
    const recorder = createGatewayStartupOutcomeRecorder({
      ...inactiveParams,
      cfg: {
        hooks: {
          enabled: true,
          internal: { enabled: true },
          gmail: { account: "private-account", model: "private-provider/private-model" },
        },
      },
    });
    const failedOutcome: GatewayStartupOutcome & { error: string; value: string } = {
      subsystem: "internal-hooks",
      status: "failed",
      reason: "see earlier log",
      error: "secret startup error",
      value: "private config value",
    };

    recorder.record(failedOutcome);
    let summary = formatGatewayStartupOutcomes(recorder.snapshot());
    expect(summary).toContain("internal-hooks=failed (see earlier log)");
    expect(summary).not.toContain("secret startup error");
    expect(summary).not.toContain("private config value");
    expect(summary).not.toContain("private-account");
    expect(summary).not.toContain("private-provider/private-model");

    recorder.record({ subsystem: "internal-hooks", status: "loaded" });
    recorder.record({ subsystem: "internal-startup-hook", status: "scheduled" });
    summary = formatGatewayStartupOutcomes(recorder.snapshot());
    expect(summary).toContain("internal-hooks=loaded");
    expect(summary).toContain("internal-startup-hook=scheduled");
  });
});
