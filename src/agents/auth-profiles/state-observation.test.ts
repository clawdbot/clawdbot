import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
  vi.unstubAllEnvs();
});

describe("logAuthProfileFailureStateChange", () => {
  it("sanitizes consoleMessage fields before logging", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("FORCE_COLOR", "0");
    vi.stubEnv("NO_COLOR", "1");
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });

    logAuthProfileFailureStateChange({
      runId: "run-1\nforged\tentry\rtest",
      profileId: "openai:profile-1",
      provider: "openai\u001b]8;;https://evil.test\u0007",
      reason: "overloaded",
      previous: undefined,
      next: {
        errorCount: 1,
        cooldownUntil: 1_700_000_060_000,
        failureCounts: { overloaded: 1 },
      },
      now: 1_700_000_000_000,
    });

    const consoleLine = warnSpy.mock.calls.at(0)?.[0];
    expect(typeof consoleLine).toBe("string");
    expect(consoleLine).toContain("runId=run-1 forged entry test");
    expect(consoleLine).toContain("provider=openai]8;;https://evil.test");
    expect(consoleLine).not.toContain("\n");
    expect(consoleLine).not.toContain("\r");
    expect(consoleLine).not.toContain("\t");
    expect(consoleLine).not.toContain("\u001b");
  });
});
