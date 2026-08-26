import { describe, expect, it } from "vitest";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  PLUGIN_CAPABILITY_CONSENT_REQUIRED,
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
      name: "Memory Plus",
      version: "2.1.0",
      declared: {
        channels: [],
        providers: [],
        tools: ["memory_search"],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: true, configured: true },
        },
      },
      source: { kind: "npm", integrity: "sha512-example", integrityKind: "ssri" },
      trust: { disposition: "clean" },
      widened: { tools: ["memory_search"] },
      acceptedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(details.capabilityConsentCode).toBe(PLUGIN_CAPABILITY_CONSENT_REQUIRED);
    expect(validateCapabilityConsentErrorDetails(details)).toBe(true);
    expect(readCapabilityConsentErrorDetails(details)).toEqual(details);

    for (const invalidDetails of [
      { ...details, capabilityConsentCode: "incorrect" },
      { ...details, declared: { ...details.declared, tools: [""] } },
      { ...details, widened: { unexpected: ["tool"] } },
      { ...details, unexpected: true },
    ]) {
      expect(readCapabilityConsentErrorDetails(invalidDetails)).toBeUndefined();
    }
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
        acknowledgeCapabilities: true,
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: true,
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
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: false },
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
        acknowledgeCapabilities: true,
      }),
    ).toBe(true);
    expect(
      validatePluginsSetEnabledParams({
        pluginId: "workboard",
        enabled: true,
        acknowledgeCapabilities: false,
      }),
    ).toBe(false);
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: "yes" })).toBe(false);
  });
});
