// Covers runtime group-policy resolution from config and context.
import { beforeEach, describe, expect, it } from "vitest";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resetMissingProviderGroupPolicyFallbackWarningsForTesting,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-group-policy.js";

beforeEach(() => {
  resetMissingProviderGroupPolicyFallbackWarningsForTesting();
});

describe("resolveRuntimeGroupPolicy", () => {
  it.each([
    {
      title: "fails closed when provider config is missing and no defaults are set",
      params: { providerConfigPresent: false },
      expectedPolicy: "allowlist",
      expectedFallbackApplied: true,
    },
    {
      title: "keeps configured fallback when provider config is present",
      params: { providerConfigPresent: true, configuredFallbackPolicy: "open" as const },
      expectedPolicy: "open",
      expectedFallbackApplied: false,
    },
    {
      title: "ignores global defaults when provider config is missing",
      params: {
        providerConfigPresent: false,
        defaultGroupPolicy: "disabled" as const,
        configuredFallbackPolicy: "open" as const,
        missingProviderFallbackPolicy: "allowlist" as const,
      },
      expectedPolicy: "allowlist",
      expectedFallbackApplied: true,
    },
  ])("$title", ({ params, expectedPolicy, expectedFallbackApplied }) => {
    const resolved = resolveRuntimeGroupPolicy(params);
    expect(resolved.groupPolicy).toBe(expectedPolicy);
    expect(resolved.providerMissingFallbackApplied).toBe(expectedFallbackApplied);
  });
});

describe("resolveOpenProviderRuntimeGroupPolicy", () => {
  it("uses open fallback when provider config exists", () => {
    const resolved = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveAllowlistProviderRuntimeGroupPolicy", () => {
  it("uses allowlist fallback when provider config exists", () => {
    const resolved = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("resolveDefaultGroupPolicy", () => {
  it("returns channels.defaults.groupPolicy when present", () => {
    const resolved = resolveDefaultGroupPolicy({
      channels: { defaults: { groupPolicy: "disabled" } },
    });
    expect(resolved).toBe("disabled");
  });
});

describe("warnMissingProviderGroupPolicyFallbackOnce", () => {
  it("logs only once per provider/account key", () => {
    const lines: string[] = [];
    const first = warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: true,
      providerKey: "runtime-policy-test",
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
    });
    const second = warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied: true,
      providerKey: "runtime-policy-test",
      accountId: "account-a",
      blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
      log: (message) => lines.push(message),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("channels.runtime-policy-test is missing");
    expect(lines[0]).toContain("room messages blocked");
  });
});
