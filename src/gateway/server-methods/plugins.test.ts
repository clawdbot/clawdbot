// Plugin management Gateway handler tests cover DTO mapping, trust errors, and reload planning.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCapabilityConsentErrorDetails,
  type CapabilityConsentErrorDetails,
} from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";

const managementMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  install: vi.fn(),
  list: vi.fn(),
  refreshMetadata: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));
const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: (...args: unknown[]) => managementMocks.inspect(...args),
  listManagedPlugins: (...args: unknown[]) => managementMocks.list(...args),
  refreshManagedPluginMetadata: (...args: unknown[]) => managementMocks.refreshMetadata(...args),
}));

vi.mock("../../plugins/management-mutations.js", () => ({
  installManagedPlugin: (...args: unknown[]) => managementMocks.install(...args),
  setManagedPluginEnabled: (...args: unknown[]) => managementMocks.setEnabled(...args),
  uninstallManagedPlugin: (...args: unknown[]) => managementMocks.uninstall(...args),
}));

vi.mock("../../plugins/catalog-search.js", () => ({
  searchInstallablePluginPackages: (...args: unknown[]) => searchMock(...args),
}));

const { pluginsHandlers: pluginReadHandlers } = await import("./plugins.js");
const { pluginMutationHandlers } = await import("./plugins-mutations.js");
const pluginsHandlers = { ...pluginReadHandlers, ...pluginMutationHandlers };

async function callHandler(
  method: string,
  params: Record<string, unknown>,
  runtimeConfig: Record<string, unknown> = {},
) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  await expectDefined(
    pluginsHandlers[method],
    "pluginsHandlers[method] test invariant",
  )({
    params,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => runtimeConfig,
      notifyPluginMetadataChanged: pluginMetadataChanged,
    } as never,
    respond: (success, result, requestError) => {
      ok = success;
      response = result;
      error = requestError;
    },
  });
  return { ok, response, error };
}

const pluginMetadataChanged = vi.fn();

const workboard = {
  id: "workboard",
  name: "Workboard",
  installed: true,
  enabled: false,
  state: "disabled" as const,
  featured: true,
  order: 10,
};

const reviewToken = "a".repeat(64);

const capabilityConsent = {
  pluginId: "workboard",
  reviewToken,
  widened: { tools: ["workboard_read"] },
  acceptedAt: "2026-08-25T00:00:00.000Z",
} satisfies Omit<CapabilityConsentErrorDetails, "capabilityConsentCode">;

describe("plugin management Gateway handlers", () => {
  beforeEach(() => {
    pluginMetadataChanged.mockReset();
    managementMocks.inspect.mockReset();
    managementMocks.install.mockReset();
    managementMocks.list.mockReset();
    managementMocks.refreshMetadata.mockReset();
    managementMocks.setEnabled.mockReset();
    managementMocks.uninstall.mockReset();
    searchMock.mockReset();
  });

  it("signals that refreshed plugin metadata requires a Gateway restart", async () => {
    const config = { plugins: { enabled: true } };
    const result = await callHandler("plugins.refresh", {}, config);

    expect(managementMocks.refreshMetadata).toHaveBeenCalledWith({ config });
    expect(pluginMetadataChanged).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      response: { ok: true, restartRequired: true },
      error: undefined,
    });
  });

  it("reports inventory refresh failures while still requesting the required restart", async () => {
    managementMocks.refreshMetadata.mockImplementationOnce(() => {
      throw new Error("plugin index unavailable");
    });

    const result = await callHandler("plugins.refresh", {});

    expect(pluginMetadataChanged).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message:
          "Plugin inventory refresh failed: plugin index unavailable. Restart the Gateway to load updated plugins.",
        details: { restartRequired: true },
      },
    });
  });

  it("returns cold Workboard inventory without claiming runtime loaded state", async () => {
    managementMocks.list.mockResolvedValue({
      plugins: [workboard],
      diagnostics: [],
      mutationAllowed: true,
    });

    const result = await callHandler("plugins.list", {});

    expect(result).toEqual({
      ok: true,
      response: { plugins: [workboard], diagnostics: [], mutationAllowed: true },
      error: undefined,
    });
  });

  it.each([
    {
      label: "bundled installed plugin",
      inspection: {
        ok: true,
        reviewToken,
        plugin: {
          id: "workboard",
          name: "Workboard",
          origin: "bundled",
          installed: true,
          enabled: true,
        },
        source: { kind: "bundled" },
        grants: {
          hooks: {
            allowPromptInjection: { effective: true },
            allowConversationAccess: { effective: true },
          },
        },
      },
    },
    {
      label: "external plugin with explicit grants, integrity, and trust",
      inspection: {
        ok: true,
        reviewToken,
        plugin: {
          id: "community-plugin",
          name: "Community Plugin",
          origin: "global",
          installed: true,
          enabled: false,
        },
        source: {
          kind: "clawhub",
          packageName: "community/plugin",
          integrity: "sha512-pinned",
          integrityKind: "ssri",
        },
        grants: {
          hooks: {
            allowPromptInjection: { effective: false, configured: false },
            allowConversationAccess: { effective: true, configured: true },
          },
        },
        trust: {
          disposition: "review-required",
          reasons: ["Install script"],
          checkedAt: "2026-08-25T00:00:00.000Z",
          acknowledgedAt: "2026-08-25T01:00:00.000Z",
          pending: false,
          stale: true,
        },
      },
    },
    {
      label: "not-installed official catalog plugin",
      inspection: {
        ok: true,
        reviewToken,
        plugin: {
          id: "diffs",
          name: "Diffs",
          origin: "official",
          installed: false,
          enabled: false,
        },
        source: {
          kind: "official-catalog",
          packageName: "@openclaw/diffs",
          integrity: "sha256-catalog-pin",
          integrityKind: "sha256",
        },
        grants: {
          hooks: {
            allowPromptInjection: { effective: true },
            allowConversationAccess: { effective: false },
          },
        },
      },
    },
  ])("returns the complete consent snapshot for a $label", async ({ inspection }) => {
    managementMocks.inspect.mockResolvedValue(inspection);
    const config = { plugins: { entries: {} } };

    const result = await callHandler("plugins.inspect", { pluginId: inspection.plugin.id }, config);

    expect(managementMocks.inspect).toHaveBeenCalledWith({
      config,
      pluginId: inspection.plugin.id,
    });
    expect(result).toEqual({ ok: true, response: inspection, error: undefined });
  });

  it("classifies unknown plugin inspections as invalid requests", async () => {
    managementMocks.inspect.mockRejectedValue(
      new ManagedPluginLifecycleError('Plugin "unknown" not found.'),
    );

    const result = await callHandler("plugins.inspect", { pluginId: "unknown" });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'Plugin "unknown" not found.',
    });
  });

  it("maps plugin-only ClawHub search results to the public DTO", async () => {
    searchMock.mockResolvedValue([
      {
        score: 0.91,
        package: {
          name: "@openclaw/diffs",
          displayName: "Diffs",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          summary: "Readable diffs",
          latestVersion: "1.2.3",
          runtimeId: "diffs",
          ownerHandle: "openclaw",
          verificationTier: "source-linked",
          stats: { downloads: 149263, installs: 280, stars: 0, versions: 83 },
        },
      },
    ]);

    const result = await callHandler("plugins.search", { query: "diff", limit: 12 });

    expect(searchMock).toHaveBeenCalledWith({ query: "diff", limit: 12 });
    expect(result.response).toEqual({
      results: [
        {
          score: 0.91,
          package: {
            name: "@openclaw/diffs",
            displayName: "Diffs",
            family: "code-plugin",
            channel: "official",
            isOfficial: true,
            summary: "Readable diffs",
            latestVersion: "1.2.3",
            runtimeId: "diffs",
            downloads: 149263,
            verificationTier: "source-linked",
          },
        },
      ],
    });
  });

  it("omits malformed ClawHub download stats from the public DTO", async () => {
    searchMock.mockResolvedValue([
      {
        score: 0.5,
        package: {
          name: "community/demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "community",
          isOfficial: false,
          stats: { downloads: Number.NaN },
        },
      },
    ]);

    const result = await callHandler("plugins.search", { query: "demo" });

    expect(result.response).toEqual({
      results: [
        {
          score: 0.5,
          package: {
            name: "community/demo",
            displayName: "Demo",
            family: "code-plugin",
            channel: "community",
            isOfficial: false,
          },
        },
      ],
    });
  });

  it("derives Workboard restart state from its exact config path", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
      warnings: ['Exclusive slot "memory" switched to "workboard".'],
    });

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(managementMocks.setEnabled).toHaveBeenCalledWith({
      pluginId: "workboard",
      enabled: true,
    });
    expect(result.response).toMatchObject({
      ok: true,
      restartRequired: false,
      warnings: ['Exclusive slot "memory" switched to "workboard".'],
    });
  });

  it("forwards the exact reviewed-surface token when enabling a plugin", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
    });

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken },
    });

    expect(result.ok).toBe(true);
    expect(managementMocks.setEnabled).toHaveBeenCalledWith({
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken },
    });
  });

  it.each([
    {
      label: "enablement with obsolete blind acknowledgement",
      method: "plugins.setEnabled",
      params: { pluginId: "workboard", enabled: true },
      mock: managementMocks.setEnabled,
      acknowledgement: true,
    },
    {
      label: "an official install with a missing review token",
      method: "plugins.install",
      params: { source: "official", pluginId: "workboard" },
      mock: managementMocks.install,
      acknowledgement: {},
    },
    {
      label: "a ClawHub install with extra acknowledgement properties",
      method: "plugins.install",
      params: { source: "clawhub", packageName: "community/workboard" },
      mock: managementMocks.install,
      acknowledgement: { reviewToken, unexpected: true },
    },
  ])("rejects $label before dispatch", async (testCase) => {
    const result = await callHandler(testCase.method, {
      ...testCase.params,
      acknowledgeCapabilities: testCase.acknowledgement,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(testCase.mock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an initial enable request",
      method: "plugins.setEnabled",
      params: { pluginId: "workboard", enabled: true },
      mock: managementMocks.setEnabled,
    },
    {
      label: "an install request with a stale review token",
      method: "plugins.install",
      params: {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "b".repeat(64) },
      },
      mock: managementMocks.install,
    },
  ])("returns fresh server-authoritative consent details for $label", async (testCase) => {
    testCase.mock.mockRejectedValue(
      new ManagedPluginLifecycleError("Plugin capability consent required", {
        capabilityConsent,
      }),
    );

    const result = await callHandler(testCase.method, testCase.params);
    const error = result.error as { code?: string; details?: unknown };

    expect(error.code).toBe("INVALID_REQUEST");
    expect(readCapabilityConsentErrorDetails(error.details)).toEqual({
      capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
      ...capabilityConsent,
    });
  });

  it.each([
    { mode: "off", restartRequired: true },
    { mode: "restart", restartRequired: false },
    { mode: "hot", restartRequired: false },
  ] as const)(
    "reports restartRequired=$restartRequired for $mode reload mode",
    async ({ mode, restartRequired }) => {
      managementMocks.setEnabled.mockResolvedValue({
        plugin: { ...workboard, enabled: true, state: "enabled" },
        changedPaths: ["plugins.entries.workboard.enabled"],
      });

      const result = await callHandler(
        "plugins.setEnabled",
        { pluginId: "workboard", enabled: true },
        { gateway: { reload: { mode } } },
      );

      expect(result.response).toMatchObject({ ok: true, restartRequired });
    },
  );

  it("classifies known enablement policy failures as invalid requests", async () => {
    managementMocks.setEnabled.mockRejectedValue(
      new ManagedPluginLifecycleError("Plugin is blocked"),
    );

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Plugin is blocked",
    });
  });

  it("classifies unexpected enablement persistence failures as unavailable", async () => {
    managementMocks.setEnabled.mockRejectedValue(new Error("rename EACCES"));

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(result.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "rename EACCES",
    });
  });

  it("forwards ClawHub risk acknowledgement and the reviewed-surface token", async () => {
    managementMocks.install.mockResolvedValue({
      plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
    });

    await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "@openclaw/diffs",
      version: "1.2.3",
      acknowledgeCapabilities: { reviewToken },
    });

    expect(managementMocks.install).toHaveBeenCalledWith({
      request: {
        source: "clawhub",
        packageName: "@openclaw/diffs",
        version: "1.2.3",
        acknowledgeCapabilities: { reviewToken },
      },
    });
  });

  it("forwards install-policy acknowledgement and the exact reviewed-surface token", async () => {
    managementMocks.install.mockResolvedValue({
      plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
    });

    await callHandler("plugins.install", {
      source: "official",
      pluginId: "diffs",
      acknowledgeInstallPolicyWarning: true,
      acknowledgeCapabilities: { reviewToken },
    });

    expect(managementMocks.install).toHaveBeenCalledWith({
      request: {
        source: "official",
        pluginId: "diffs",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken },
      },
    });
  });

  it("returns tokenless structured install policy warning details", async () => {
    managementMocks.install.mockRejectedValue(
      new ManagedPluginLifecycleError("Review required", {
        installPolicyWarning: {
          targetName: "diffs",
          targetType: "plugin",
          requestMode: "install",
          reason: "Review the staged package",
          findings: [
            {
              ruleId: "suspicious-script",
              severity: "warn",
              message: "The package contains an install script.",
            },
          ],
        },
      }),
    );

    const result = await callHandler("plugins.install", {
      source: "official",
      pluginId: "diffs",
    });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        installPolicyCode: "install_policy_warning_acknowledgement_required",
        targetName: "diffs",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review the staged package",
        findings: [
          {
            ruleId: "suspicious-script",
            severity: "warn",
            message: "The package contains an install script.",
          },
        ],
      },
    });
    expect(result.error).not.toHaveProperty("details.acknowledgementToken");
  });

  it("classifies ClawHub security outages as unavailable", async () => {
    managementMocks.install.mockRejectedValue(
      new ManagedPluginLifecycleError("Security service unavailable", {
        kind: "unavailable",
        code: "clawhub_security_unavailable",
      }),
    );

    const result = await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "community/plugin",
    });

    expect(result.error).toMatchObject({
      code: "UNAVAILABLE",
      details: { clawhubTrustCode: "clawhub_security_unavailable" },
    });
  });

  it("classifies unexpected install persistence failures as unavailable", async () => {
    managementMocks.install.mockRejectedValue(new Error("disk full"));

    const result = await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "community/plugin",
    });

    expect(result.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "disk full",
    });
  });

  it("returns removal actions and forces restart after uninstall", async () => {
    managementMocks.uninstall.mockResolvedValue({
      pluginId: "diffs",
      removed: ["config entry", "install record", "directory"],
      warnings: ["npm prune skipped"],
    });

    const result = await callHandler("plugins.uninstall", { pluginId: "diffs" });

    expect(managementMocks.uninstall).toHaveBeenCalledWith({ pluginId: "diffs" });
    expect(result).toEqual({
      ok: true,
      response: {
        ok: true,
        pluginId: "diffs",
        restartRequired: true,
        removed: ["config entry", "install record", "directory"],
        warnings: ["npm prune skipped"],
      },
      error: undefined,
    });
  });

  it("classifies bundled uninstall refusals as invalid requests", async () => {
    managementMocks.uninstall.mockRejectedValue(
      new ManagedPluginLifecycleError(
        "bundled plugin cannot be uninstalled: workboard; disable it instead",
      ),
    );

    const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "bundled plugin cannot be uninstalled: workboard; disable it instead",
    });
  });
});
