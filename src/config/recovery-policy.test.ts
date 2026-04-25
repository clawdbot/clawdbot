import { describe, expect, it } from "vitest";
import {
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type PolicySnapshot = Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">;

function snapshot(params: Partial<PolicySnapshot>): PolicySnapshot {
  return {
    valid: false,
    issues: [],
    legacyIssues: [],
    ...params,
  };
}

describe("config recovery policy", () => {
  it("skips whole-file recovery for issues scoped only to plugin entries", () => {
    const current = snapshot({
      issues: [
        {
          path: "plugins.entries.feishu",
          message: "plugin requires newer host",
        },
        {
          path: "plugins.entries.lossless-claw.config.cacheAwareCompaction",
          message: "invalid config: must NOT have additional properties",
        },
      ],
    });

    expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(true);
    expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(false);
  });

  it("keeps recovery enabled for mixed plugin and root config invalidity", () => {
    const current = snapshot({
      issues: [
        { path: "plugins.entries.feishu", message: "plugin requires newer host" },
        { path: "gateway.mode", message: "Expected string" },
      ],
    });

    expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(false);
    expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(true);
  });

  it("keeps recovery enabled for ambiguous plugin collection issues", () => {
    const current = snapshot({
      issues: [{ path: "plugins.entries", message: "Expected object" }],
    });

    expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(false);
    expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(true);
  });

  it("keeps recovery enabled when legacy config issues are present", () => {
    const current = snapshot({
      issues: [{ path: "plugins.entries.feishu", message: "plugin requires newer host" }],
      legacyIssues: [{ path: "heartbeat", message: "Use agents.defaults.heartbeat" }],
    });

    expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(false);
    expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(true);
  });
});
