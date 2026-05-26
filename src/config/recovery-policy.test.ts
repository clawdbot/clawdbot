import { describe, expect, it } from "vitest";
import {
  isPluginPackagingRuntimeOutputInvalidConfigSnapshot,
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type PolicySnapshot = Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings" | "legacyIssues">;

function snapshot(params: Partial<PolicySnapshot>): PolicySnapshot {
  return {
    valid: false,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...params,
  };
}

describe("config recovery policy", () => {
  it("skips whole-file recovery for issues scoped only to stale plugin refs", () => {
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
        {
          path: "plugins.allow",
          message: "plugin not found: acpx",
        },
        {
          path: "plugins.deny",
          message: "plugin not found: missing-deny",
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

  it("keeps recovery enabled for malformed plugin policy values", () => {
    for (const path of ["plugins.allow", "plugins.deny"]) {
      const current = snapshot({
        issues: [{ path, message: "Invalid input: expected array, received string" }],
      });

      expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(false);
      expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(true);
    }
  });

  it("keeps recovery enabled when legacy config issues are present", () => {
    const current = snapshot({
      issues: [{ path: "plugins.entries.feishu", message: "plugin requires newer host" }],
      legacyIssues: [{ path: "heartbeat", message: "Use agents.defaults.heartbeat" }],
    });

    expect(isPluginLocalInvalidConfigSnapshot(current)).toBe(false);
    expect(shouldAttemptLastKnownGoodRecovery(current)).toBe(true);
  });

  it("classifies plugin packaging compiled-output failures with plugin-not-found fallout", () => {
    const current = snapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
    });

    expect(isPluginPackagingRuntimeOutputInvalidConfigSnapshot(current)).toBe(true);
  });

  it("does not classify mixed core invalidity as a plugin packaging-only failure", () => {
    const current = snapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
        },
      ],
    });

    expect(isPluginPackagingRuntimeOutputInvalidConfigSnapshot(current)).toBe(false);
  });

  it("does not classify unrelated missing plugins as packaging fallout", () => {
    const current = snapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: missing-memory",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
        },
      ],
    });

    expect(isPluginPackagingRuntimeOutputInvalidConfigSnapshot(current)).toBe(false);
  });
});
