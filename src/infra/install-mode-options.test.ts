// Tests install mode option parsing for setup commands.
import { describe, expect, it } from "vitest";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "./install-mode-options.js";

type LoggerKey = "default" | "explicit";

describe("install mode option helpers", () => {
  it.each([
    {
      name: "applies logger, mode, and dryRun defaults",
      params: {},
      expected: { loggerKey: "default", mode: "install", dryRun: false },
    },
    {
      name: "preserves explicit mode and dryRun values",
      params: { loggerKey: "explicit", mode: "update" as const, dryRun: true },
      expected: { loggerKey: "explicit", mode: "update", dryRun: true },
    },
    {
      name: "preserves explicit false dryRun values",
      params: { mode: "update" as const, dryRun: false },
      expected: { loggerKey: "default", mode: "update", dryRun: false },
    },
  ] satisfies Array<{
    name: string;
    params: { loggerKey?: LoggerKey; mode?: "install" | "update"; dryRun?: boolean };
    expected: { loggerKey: LoggerKey; mode: "install" | "update"; dryRun: boolean };
  }>)("$name", ({ params, expected }) => {
    const loggers = {
      default: { warn: (_message: string) => {} },
      explicit: { warn: (_message: string) => {} },
    } satisfies Record<LoggerKey, { warn: (_message: string) => void }>;

    expect(
      resolveInstallModeOptions(
        {
          logger: params.loggerKey ? loggers[params.loggerKey] : undefined,
          mode: params.mode,
          dryRun: params.dryRun,
        },
        loggers.default,
      ),
    ).toEqual({
      logger: loggers[expected.loggerKey],
      mode: expected.mode,
      dryRun: expected.dryRun,
    });
  });

  it.each([
    {
      name: "uses default timeout when not provided",
      params: {},
      defaultTimeoutMs: undefined,
      expectedTimeoutMs: 120_000,
      expectedMode: "install",
      expectedDryRun: false,
    },
    {
      name: "honors custom timeout default override",
      params: {},
      defaultTimeoutMs: 5000,
      expectedTimeoutMs: 5000,
      expectedMode: "install",
      expectedDryRun: false,
    },
    {
      name: "preserves explicit timeout values",
      params: { timeoutMs: 0, mode: "update" as const, dryRun: true },
      defaultTimeoutMs: 5000,
      expectedTimeoutMs: 0,
      expectedMode: "update",
      expectedDryRun: true,
    },
  ])("$name", ({ params, defaultTimeoutMs, expectedTimeoutMs, expectedMode, expectedDryRun }) => {
    const logger = { warn: (_message: string) => {} };
    const result = resolveTimedInstallModeOptions(params, logger, defaultTimeoutMs);

    expect(result.timeoutMs).toBe(expectedTimeoutMs);
    expect(result.mode).toBe(expectedMode);
    expect(result.dryRun).toBe(expectedDryRun);
    expect(result.logger).toBe(logger);
  });
});
