import { describe, expect, it } from "vitest";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../config/runtime-group-policy.js";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "./test-helpers/group-policy-contract-suites.js";
import {
  resolveZaloRuntimeGroupPolicy,
  resolveWhatsAppRuntimeGroupPolicy,
} from "./test-helpers/group-policy-contract.js";

describe("channel runtime group policy fallback contract", () => {
  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.slack is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.slack is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("telegram", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.telegram is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.telegram is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit defaults when provider config is missing",
    });
  });

  describe("whatsapp", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveWhatsAppRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.whatsapp is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.whatsapp is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("imessage", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it.each([
      {
        providerConfigPresent: false,
        groupPolicy: "disabled",
      },
    ] as const)("respects explicit provider policy %#", (testCase) => {
      const resolved = resolveOpenProviderRuntimeGroupPolicy(testCase);
      expect(resolved.groupPolicy).toBe("disabled");
      expect(resolved.providerMissingFallbackApplied).toBe(false);
    });
  });

  describe("zalo", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveZaloRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.zalo is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.zalo is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });
});
