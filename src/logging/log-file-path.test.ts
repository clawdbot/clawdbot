// Log file path tests cover profile-aware rolling filename resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLegacyRollingLogFilePath,
  isSameRollingLogFileFamily,
  resolveConfiguredLogFilePath,
  resolveRollingLogFilePathForDate,
} from "./log-file-path.js";

const date = new Date(2026, 6, 22, 12, 0, 0);

describe("resolveConfiguredLogFilePath", () => {
  it.each([
    { name: "unset", env: {}, expected: "openclaw-2026-07-22.log" },
    {
      name: "explicit default",
      env: { OPENCLAW_PROFILE: "Default" },
      expected: "openclaw-2026-07-22.log",
    },
    {
      name: "named",
      env: { OPENCLAW_PROFILE: "dev" },
      expected: "openclaw-dev-2026-07-22.log",
    },
    {
      name: "sanitized",
      env: { OPENCLAW_PROFILE: "QA_Profile" },
      expected: "openclaw--1q-1a-0-1profile-2026-07-22.log",
    },
  ])("uses the $name profile filename", ({ env, expected }) => {
    const resolved = resolveConfiguredLogFilePath(undefined, { date, env });

    expect(path.basename(resolved)).toBe(expected);
  });

  it("keeps profiles distinct when sanitization would otherwise collide", () => {
    const underscored = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "QA_Profile" },
    });
    const dashed = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "qa-profile" },
    });

    expect(underscored).not.toBe(dashed);
    expect(path.basename(dashed)).toBe("openclaw-qa--profile-2026-07-22.log");
  });

  it("keeps escaped output distinct from a profile that resembles the encoding", () => {
    const transformed = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "QA_Profile" },
    });
    const lookalike = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "-1q-1a-0-1profile" },
    });

    expect(transformed).not.toBe(lookalike);
  });

  it("bounds direct environment profiles that exceed the CLI length contract", () => {
    const first = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "A".repeat(80) },
    });
    const second = resolveConfiguredLogFilePath(undefined, {
      date,
      env: { OPENCLAW_PROFILE: "B".repeat(80) },
    });

    expect(path.basename(first)).toMatch(/^openclaw--3[a-f0-9]{64}-2026-07-22\.log$/u);
    expect(path.basename(first).length).toBeLessThanOrEqual(255);
    expect(first).not.toBe(second);
  });

  it("preserves an explicit logging.file override", () => {
    expect(
      resolveConfiguredLogFilePath(
        { logging: { file: "/var/log/openclaw/custom.log" } },
        { date, env: { OPENCLAW_PROFILE: "dev" } },
      ),
    ).toBe("/var/log/openclaw/custom.log");
  });
});

describe("profile rolling log families", () => {
  it("preserves the profile segment across date rollover", () => {
    expect(
      resolveRollingLogFilePathForDate(
        "/tmp/openclaw/openclaw-dev-2026-07-22.log",
        new Date(2026, 6, 23, 12, 0, 0),
      ),
    ).toBe("/tmp/openclaw/openclaw-dev-2026-07-23.log");
  });

  it("expands the legacy YYYY-MM-DD placeholder", () => {
    expect(
      resolveRollingLogFilePathForDate(
        "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
        new Date(2026, 6, 23, 12, 0, 0),
      ),
    ).toBe("/tmp/openclaw/openclaw-2026-07-23.log");
  });

  it("keeps default and named profile fallback families separate", () => {
    expect(
      isSameRollingLogFileFamily("openclaw-dev-2026-07-22.log", "openclaw-dev-2026-07-21.log"),
    ).toBe(true);
    expect(
      isSameRollingLogFileFamily("openclaw-dev-2026-07-22.log", "openclaw-2026-07-22.log"),
    ).toBe(false);
  });

  it("keeps legacy explicit dated paths rolling without broadening the override contract", () => {
    expect(isLegacyRollingLogFilePath("openclaw-2026-07-22.log")).toBe(true);
    expect(isLegacyRollingLogFilePath("openclaw-YYYY-MM-DD.log")).toBe(true);
    expect(isLegacyRollingLogFilePath("openclaw-dev-2026-07-22.log")).toBe(false);
  });
});
