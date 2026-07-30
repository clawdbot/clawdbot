// Plugin management Gateway handler tests cover DTO mapping, trust errors, and reload planning.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const managementMocks = vi.hoisted(() => {
  class ManagedPluginLifecycleError extends Error {
    readonly kind: "invalid-request" | "unavailable";
    readonly code?: string;
    readonly version?: string;
    readonly warning?: string;

    constructor(
      message: string,
      details?: {
        kind?: "invalid-request" | "unavailable";
        code?: string;
        version?: string;
        warning?: string;
      },
    ) {
      super(message);
      this.kind = details?.kind ?? "invalid-request";
      this.code = details?.code;
      this.version = details?.version;
      this.warning = details?.warning;
    }
  }
  return {
    ManagedPluginLifecycleError,
    install: vi.fn(),
    list: vi.fn(),
    setEnabled: vi.fn(),
    uninstall: vi.fn(),
  };
});
const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/management-service.js", () => ({
  ManagedPluginLifecycleError: managementMocks.ManagedPluginLifecycleError,
  formatManagedPluginLifecycleError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  installManagedPlugin: (...args: unknown[]) => managementMocks.install(...args),
  listManagedPlugins: (...args: unknown[]) => managementMocks.list(...args),
  setManagedPluginEnabled: (...args: unknown[]) => managementMocks.setEnabled(...args),
  uninstallManagedPlugin: (...args: unknown[]) => managementMocks.uninstall(...args),
}));

vi.mock("../../plugins/catalog-search.js", () => ({
  searchInstallablePluginPackages: (...args: unknown[]) => searchMock(...args),
}));

const { pluginsHandlers } = await import("./plugins.js");

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

describe("plugin management Gateway handlers", () => {
  beforeEach(() => {
    pluginMetadataChanged.mockReset();
    managementMocks.install.mockReset();
    managementMocks.list.mockReset();
    managementMocks.setEnabled.mockReset();
    managementMocks.uninstall.mockReset();
    searchMock.mockReset();
  });

  it("signals the config reloader after persisted plugin metadata changes", async () => {
    const result = await callHandler("plugins.refresh", {});

    expect(pluginMetadataChanged).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, response: { ok: true }, error: undefined });
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
      new managementMocks.ManagedPluginLifecycleError("Plugin is blocked"),
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

  it("forwards explicit ClawHub risk acknowledgement", async () => {
    managementMocks.install.mockResolvedValue({
      plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
    });

    await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "@openclaw/diffs",
      version: "1.2.3",
      acknowledgeClawHubRisk: true,
    });

    expect(managementMocks.install).toHaveBeenCalledWith({
      request: {
        source: "clawhub",
        packageName: "@openclaw/diffs",
        version: "1.2.3",
        acknowledgeClawHubRisk: true,
      },
    });
  });

  it("returns structured ClawHub acknowledgement details", async () => {
    managementMocks.install.mockRejectedValue(
      new managementMocks.ManagedPluginLifecycleError("Review required", {
        kind: "invalid-request",
        code: "clawhub_risk_acknowledgement_required",
        version: "1.2.3",
        warning: "Suspicious release",
      }),
    );

    const result = await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "community/plugin",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Review required",
      details: {
        clawhubTrustCode: "clawhub_risk_acknowledgement_required",
        version: "1.2.3",
        warning: "Suspicious release",
      },
    });
  });

  it("classifies ClawHub security outages as unavailable", async () => {
    managementMocks.install.mockRejectedValue(
      new managementMocks.ManagedPluginLifecycleError("Security service unavailable", {
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
      new managementMocks.ManagedPluginLifecycleError(
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
