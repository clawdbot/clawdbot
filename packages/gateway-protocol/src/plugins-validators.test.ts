import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  PLUGIN_CAPABILITY_CONSENT_REQUIRED,
  PluginsInspectResultSchema,
  buildCapabilityConsentErrorDetails,
  readCapabilityConsentErrorDetails,
  readInstallPolicyWarningErrorDetails,
  validateCapabilityConsentErrorDetails,
  validatePluginsInspectParams,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
  type InstallPolicyWarningErrorDetails,
} from "./index.js";

describe("plugin lifecycle protocol validators", () => {
  it("exports install policy warning details from the package root", () => {
    const details: InstallPolicyWarningErrorDetails = {
      installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
      targetName: "memory-plus",
      targetType: "plugin",
      requestMode: "install",
      reason: "review this plugin",
    };

    expect(readInstallPolicyWarningErrorDetails(details)).toEqual(details);
  });

  it("round-trips closed capability consent details through the public package boundary", () => {
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "memory-plus",
      reviewToken: "surface-sha256",
      widened: { tools: ["memory_search"], contracts: ["workerProviders: worker"] },
      acceptedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(details.capabilityConsentCode).toBe(PLUGIN_CAPABILITY_CONSENT_REQUIRED);
    expect(validateCapabilityConsentErrorDetails(details)).toBe(true);
    expect(readCapabilityConsentErrorDetails(details)).toEqual(details);

    for (const invalidDetails of [
      { ...details, capabilityConsentCode: "incorrect" },
      { ...details, pluginId: "" },
      { ...details, reviewToken: "" },
      { ...details, widened: { tools: [""] } },
      { ...details, widened: { unexpected: ["tool"] } },
      { ...details, acceptedAt: "" },
      { ...details, name: "Memory Plus" },
      { ...details, unexpected: true },
    ]) {
      expect(validateCapabilityConsentErrorDetails(invalidDetails)).toBe(false);
      expect(readCapabilityConsentErrorDetails(invalidDetails)).toBeUndefined();
    }

    const whitespaceDetails = buildCapabilityConsentErrorDetails({
      pluginId: " memory-plus ",
      reviewToken: " surface-sha256 ",
      widened: { contracts: [" workerProviders: worker "] },
      acceptedAt: " 2026-08-25T00:00:00.000Z ",
    });
    expect(validateCapabilityConsentErrorDetails(whitespaceDetails)).toBe(true);
    expect(readCapabilityConsentErrorDetails(whitespaceDetails)).toEqual(whitespaceDetails);
  });

  it("validates plugin metadata refresh params", () => {
    expect(validatePluginsRefreshParams({})).toBe(true);
    expect(validatePluginsRefreshParams({ unexpected: true })).toBe(false);
  });

  it("keeps list params closed", () => {
    expect(validatePluginsListParams({})).toBe(true);
    expect(validatePluginsListParams({ unexpected: true })).toBe(false);
  });

  it("requires exactly one non-empty plugin id for inspection", () => {
    expect(validatePluginsInspectParams({ pluginId: "workboard" })).toBe(true);
    expect(validatePluginsInspectParams({ pluginId: "" })).toBe(false);
    expect(validatePluginsInspectParams({})).toBe(false);
    expect(validatePluginsInspectParams({ pluginId: "workboard", unexpected: true })).toBe(false);
  });

  it("requires inspection review tokens and complete declared contract surfaces", () => {
    const result = {
      ok: true,
      plugin: { id: "workboard", name: "Workboard", installed: true, enabled: false },
      reviewToken: "surface-sha256",
      declared: {
        channels: [],
        providers: [],
        tools: [],
        contracts: ["workerProviders: worker"],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      },
    };

    expect(Value.Check(PluginsInspectResultSchema, result)).toBe(true);
    expect(Value.Check(PluginsInspectResultSchema, { ...result, reviewToken: "" })).toBe(false);
    const { reviewToken: _reviewToken, ...withoutReviewToken } = result;
    expect(Value.Check(PluginsInspectResultSchema, withoutReviewToken)).toBe(false);
    const { contracts: _contracts, ...withoutContracts } = result.declared;
    expect(Value.Check(PluginsInspectResultSchema, { ...result, declared: withoutContracts })).toBe(
      false,
    );
  });

  it("validates bounded plugin search requests", () => {
    expect(validatePluginsSearchParams({ query: "memory", limit: 20 })).toBe(true);
    expect(validatePluginsSearchParams({ query: "memory", limit: 101 })).toBe(false);
  });

  it("keeps official and ClawHub install requests distinct", () => {
    expect(
      validatePluginsInstallParams({
        source: "clawhub",
        packageName: "memory-plus",
        version: "2.1.0",
        acknowledgeClawHubRisk: true,
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        acknowledgeInstallPolicyWarning: false,
      }),
    ).toBe(false);
    for (const request of [
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: true },
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: false },
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: {} },
      {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "" },
      },
      {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "surface-sha256", unexpected: true },
      },
      { source: "clawhub", packageName: "memory-plus", acknowledgeCapabilities: true },
      { source: "clawhub", packageName: "memory-plus", acknowledgeCapabilities: false },
    ]) {
      expect(validatePluginsInstallParams(request)).toBe(false);
    }
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        packageName: "memory-plus",
      }),
    ).toBe(false);
  });

  it("validates uninstall requests", () => {
    expect(validatePluginsUninstallParams({ pluginId: "memory-plus" })).toBe(true);
    expect(validatePluginsUninstallParams({ pluginId: "" })).toBe(false);
    expect(validatePluginsUninstallParams({})).toBe(false);
  });

  it("validates enablement mutations", () => {
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: true })).toBe(true);
    expect(
      validatePluginsSetEnabledParams({
        pluginId: "workboard",
        enabled: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    for (const acknowledgment of [
      true,
      false,
      {},
      { reviewToken: "" },
      { reviewToken: "surface-sha256", unexpected: true },
    ]) {
      expect(
        validatePluginsSetEnabledParams({
          pluginId: "workboard",
          enabled: true,
          acknowledgeCapabilities: acknowledgment,
        }),
      ).toBe(false);
    }
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: "yes" })).toBe(false);
  });
});
