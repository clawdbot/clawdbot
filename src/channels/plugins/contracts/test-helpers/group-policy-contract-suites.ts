import { expect, it } from "vitest";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../config/runtime-group-policy.js";

type ResolvedGroupPolicy = ReturnType<typeof resolveOpenProviderRuntimeGroupPolicy>;

export type RuntimeGroupPolicyResolver = (
  params: Parameters<typeof resolveOpenProviderRuntimeGroupPolicy>[0],
) => ReturnType<typeof resolveOpenProviderRuntimeGroupPolicy>;

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

export function expectResolvedGroupPolicyCase(
  resolved: Pick<ResolvedGroupPolicy, "groupPolicy" | "providerMissingFallbackApplied">,
  expected: Pick<ResolvedGroupPolicy, "groupPolicy" | "providerMissingFallbackApplied">,
) {
  expect(resolved.groupPolicy).toBe(expected.groupPolicy);
  expect(resolved.providerMissingFallbackApplied).toBe(expected.providerMissingFallbackApplied);
}
