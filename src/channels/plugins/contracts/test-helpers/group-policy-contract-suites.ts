import { expect, it } from "vitest";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../config/runtime-group-policy.js";

// Shared runtime group-policy contract for open-provider channels. Missing
// provider config must fail closed to allowlist regardless of open defaults.
export type RuntimeGroupPolicyResolver = (
  params: Parameters<typeof resolveOpenProviderRuntimeGroupPolicy>[0],
) => ReturnType<typeof resolveOpenProviderRuntimeGroupPolicy>;

/** Installs fallback-policy tests for a channel-specific resolver wrapper. */
export function installChannelRuntimeGroupPolicyFallbackSuite(params: {
  configuredLabel: string;
  defaultGroupPolicyUnderTest: "allowlist" | "disabled" | "open";
  missingConfigLabel: string;
  missingDefaultLabel: string;
  resolve: RuntimeGroupPolicyResolver;
}) {
  it(params.missingConfigLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it(params.configuredLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it(params.missingDefaultLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
      defaultGroupPolicy: params.defaultGroupPolicyUnderTest,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
}
