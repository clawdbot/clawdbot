import { describe, expect, it } from "vitest";
import { resolveCronSessionRetentionMs } from "./session-retention.js";

const DEFAULT_CRON_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

describe("resolveCronSessionRetentionMs", () => {
  it.each([
    { config: undefined, expected: DEFAULT_CRON_SESSION_RETENTION_MS },
    { config: {}, expected: DEFAULT_CRON_SESSION_RETENTION_MS },
    { config: { sessionRetention: "1h" as const }, expected: 60 * 60 * 1000 },
    {
      config: { sessionRetention: "not-a-duration" as const },
      expected: DEFAULT_CRON_SESSION_RETENTION_MS,
    },
    { config: { sessionRetention: false as const }, expected: null },
  ])("resolves $config.sessionRetention", ({ config, expected }) => {
    expect(resolveCronSessionRetentionMs(config)).toBe(expected);
  });
});
