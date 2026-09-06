// Plugin management Gateway handler tests cover DTO mapping, trust errors, and reload planning.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  readCapabilityConsentErrorDetails,
  type CapabilityConsentErrorDetails,
} from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { formatCliJsonFailure, formatCliOperatorError } from "../../cli/failure-output.js";
import { PluginRuntimeApplicationError } from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginServiceHealthReporter } from "../../plugins/service-health.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import type { GatewayRequestContext } from "./types.js";

const managementMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  install: vi.fn(),
  list: vi.fn(),
  refreshMetadata: vi.fn(),
  reload: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));
const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: (...args: unknown[]) => managementMocks.inspect(...args),
  listManagedPlugins: (...args: unknown[]) => managementMocks.list(...args),
}));
vi.mock("../../plugins/management-mutations.js", () => ({
  installManagedPlugin: (...args: unknown[]) => managementMocks.install(...args),
  refreshManagedPlugins: (...args: unknown[]) => managementMocks.refreshMetadata(...args),
  reloadManagedPlugin: (...args: unknown[]) => managementMocks.reload(...args),
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
  context?: GatewayRequestContext,
) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: ErrorShape | undefined;
  await expectDefined(
    pluginsHandlers[method],
    "pluginsHandlers[method] test invariant",
  )({
    params,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
    context:
      context ??
      ({
        getRuntimeConfig: () => runtimeConfig,
        applyPluginLifecycleChange: applyRuntime,
      } as never),
    respond: (success, result, requestError) => {
      ok = success;
      response = result;
      error = requestError;
    },
  });
  return { ok, response, error };
}

const application = { operationId: "test-operation", generation: 42, pluginIds: ["workboard"] };
const applyRuntime = vi.fn();

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
    resetPluginRuntimeStateForTest();
    applyRuntime.mockReset().mockResolvedValue(application);
    managementMocks.reload.mockReset();
    managementMocks.inspect.mockReset();
    managementMocks.install.mockReset();
    managementMocks.list.mockReset();
    managementMocks.refreshMetadata.mockReset().mockResolvedValue({ application });
    managementMocks.setEnabled.mockReset();
    managementMocks.uninstall.mockReset();
    searchMock.mockReset();
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  it("rejects embedded local mutations before entering plugin management", async () => {
    await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => ({}) },
      async () => {
        const context = expectDefined(
          getPluginRuntimeGatewayRequestScope()?.context,
          "local Gateway request context",
        );
        for (const [method, params] of [
          ["plugins.install", { source: "official", pluginId: "workboard" }],
          ["plugins.setEnabled", { pluginId: "workboard", enabled: false }],
          ["plugins.uninstall", { pluginId: "workboard" }],
          ["plugins.reload", { pluginId: "workboard" }],
          ["plugins.refresh", {}],
        ] as const) {
          expect(await callHandler(method, params, {}, context)).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Plugin lifecycle changes require a running Gateway.",
            },
          });
        }
      },
    );
    for (const operation of [
      managementMocks.install,
      managementMocks.setEnabled,
      managementMocks.uninstall,
      managementMocks.reload,
      managementMocks.refreshMetadata,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("returns the applied metadata generation without restarting", async () => {
    const result = await callHandler("plugins.refresh", {});
    expect(managementMocks.refreshMetadata).toHaveBeenCalledWith({
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
    });
    expect(result).toEqual({
      ok: true,
      response: { ok: true, restartRequired: false, runtime: application },
      error: undefined,
    });
  });

  it("waits for the runtime receipt and preserves the reload consent token", async () => {
    let complete!: (value: typeof application) => void;
    applyRuntime.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    managementMocks.reload.mockImplementation(async (params) => ({
      pluginId: params.pluginId,
      application: await params.applyRuntime({
        config: {},
        pluginIds: [params.pluginId],
        reason: "reload",
      }),
    }));
    let responded = false;
    const pending = callHandler("plugins.reload", {
      pluginId: "workboard",
      acknowledgeCapabilities: { reviewToken },
    }).then((result) => {
      responded = true;
      return result;
    });
    await Promise.resolve();
    expect(responded).toBe(false);
    complete(application);
    expect(await pending).toMatchObject({
      ok: true,
      response: { runtime: application, restartRequired: false },
    });
    expect(managementMocks.reload).toHaveBeenCalledWith({
      pluginId: "workboard",
      acknowledgeCapabilities: { reviewToken },
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
    });
    expect(applyRuntime).toHaveBeenCalledExactlyOnceWith({
      config: {},
      pluginIds: ["workboard"],
      reason: "reload",
      assertInvokerOwned: expect.any(Function),
    });
  });

  it.each([
    {
      phase: "drain",
      committed: false,
      message: "Plugin did not stop",
      expected: "Plugin did not stop\nGateway generation 42: replacement not applied.",
    },
    {
      phase: "dispose",
      committed: true,
      message: "Old plugin cleanup failed",
      expected: "Old plugin cleanup failed\nGateway generation 42: replacement applied.",
    },
  ] as const)(
    "reports $phase failure with publication outcome in RPC and CLI errors",
    async ({ phase, committed, message, expected }) => {
      const details = { ...application, phase, committed };
      managementMocks.reload.mockRejectedValue(new PluginRuntimeApplicationError(message, details));
      const result = await callHandler("plugins.reload", { pluginId: "workboard" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expected, details: { runtime: details } },
      });
      const error = new GatewayClientRequestError(expectDefined(result.error, "reload RPC error"));
      const options = { argv: [], env: {} };
      expect(formatCliOperatorError(error, options)).toBe(expected);
      expect(formatCliJsonFailure(error, options)).toEqual({
        ok: false,
        error: { type: "cli_error", message: expected },
      });
    },
  );

  it("reports runtime application failure instead of a successful policy mutation", async () => {
    managementMocks.setEnabled.mockRejectedValue(new Error("old plugin service did not stop"));
    expect(
      await callHandler("plugins.setEnabled", { pluginId: "workboard", enabled: false }),
    ).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "old plugin service did not stop" },
    });
  });

  it.each([
    { code: undefined, installSource: undefined },
    { code: "missing-plugin-manifest", installSource: undefined },
    {
      code: "missing_openclaw_extensions",
      installSource: { source: "npm" as const, spec: "@example/hooks@1.0.0" },
    },
    {
      code: "missing_openclaw_extensions",
      installSource: { source: "clawhub" as const, spec: "clawhub:hooks@1.0.0" },
    },
  ])(
    "marks only artifact rejection and its selected source for hook fallback ($code)",
    async ({ code, installSource }) => {
      managementMocks.install.mockRejectedValue(
        new ManagedPluginLifecycleError("Artifact is not a plugin", {
          installRejected: true,
          installSource,
          ...(code ? { code } : {}),
        }),
      );
      const result = await callHandler(
        "plugins.install",
        installSource
          ? { source: "official", pluginId: "hooks" }
          : { source: "local", path: "/tmp/hooks" },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          details: {
            pluginInstallRejected: true,
            ...(code ? { pluginInstallCode: code } : {}),
            ...(installSource ? { pluginInstallSource: installSource } : {}),
          },
        },
      });
      managementMocks.install.mockRejectedValue(new Error("Runtime did not activate"));
      expect(await callHandler("plugins.install", { source: "local", path: "/tmp/hooks" })).toEqual(
        {
          ok: false,
          response: undefined,
          error: { code: "UNAVAILABLE", message: "Runtime did not activate" },
        },
      );
    },
  );

  it("returns cold Workboard inventory without claiming runtime loaded state", async () => {
    managementMocks.list.mockResolvedValue({
      plugins: [workboard],
      diagnostics: [],
      mutationAllowed: true,
    });

    const result = await callHandler("plugins.list", {});

    expect(result).toEqual({
      ok: true,
      response: {
        generation: expect.any(Number),
        plugins: [{ ...workboard, runtime: { state: "unloaded" } }],
        diagnostics: [],
        mutationAllowed: true,
      },
      error: undefined,
    });
    expect(managementMocks.list).toHaveBeenCalledWith({});
  });

  it.each([
    { status: "loaded" as const, runtime: { state: "active" } },
    { status: "disabled" as const, runtime: { state: "disabled" } },
    { status: "error" as const, runtime: { state: "unloaded", error: "Registration failed" } },
  ])(
    "reports authoritative $status despite disabled shadow records",
    async ({ status, runtime }) => {
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(
        createPluginRecord({ id: "unrelated-plugin", status: "loaded" }),
        createPluginRecord({ id: workboard.id, status, error: runtime.error }),
        createPluginRecord({
          id: workboard.id,
          status: "disabled",
          error: "overridden by selected plugin source",
        }),
      );
      setActivePluginRegistry(registry);
      managementMocks.list.mockResolvedValue({
        plugins: [workboard],
        diagnostics: [],
        mutationAllowed: true,
      });

      expect(
        await callHandler(
          "plugins.list",
          {},
          { plugins: { entries: { workboard: { enabled: true } } } },
        ),
      ).toEqual({
        ok: true,
        response: {
          generation: expect.any(Number),
          plugins: [{ ...workboard, runtime }],
          diagnostics: [],
          mutationAllowed: true,
        },
        error: undefined,
      });
      expect(managementMocks.list).toHaveBeenCalledWith({});
    },
  );

  it("reports only the current service instance's bounded failure despite a retained request registry", async () => {
    const oldRegistry = createEmptyPluginRegistry();
    const currentRegistry = createEmptyPluginRegistry();
    for (const registry of [oldRegistry, currentRegistry]) {
      registry.plugins.push(createPluginRecord({ id: workboard.id }));
      registry.services.push({
        pluginId: workboard.id,
        source: "test",
        origin: "bundled",
        service: { id: "background", start: () => {} },
      });
    }
    createPluginServiceHealthReporter(
      expectDefined(oldRegistry.services[0], "old service"),
    ).health.reportFailure("Retired service failed");
    const currentHealth = createPluginServiceHealthReporter(
      expectDefined(currentRegistry.services[0], "current service"),
    ).health;
    setActivePluginRegistry(currentRegistry);
    managementMocks.list.mockResolvedValue({
      plugins: [workboard],
      diagnostics: [],
      mutationAllowed: true,
    });
    const list = () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: oldRegistry, isWebchatConnect: () => false },
        () => callHandler("plugins.list", {}),
      );

    expect(await list()).toMatchObject({
      response: { plugins: [{ runtime: { state: "active" } }] },
    });
    currentHealth.reportFailure("x".repeat(3000));
    expect(await list()).toMatchObject({
      response: {
        plugins: [
          {
            runtime: {
              state: "service-failed",
              error: `background: ${"x".repeat(3000)}`.slice(0, 2000),
            },
          },
        ],
      },
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

  it("returns the runtime receipt after enablement", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      application,
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
      warnings: ['Exclusive slot "memory" switched to "workboard".'],
    });

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(managementMocks.setEnabled).toHaveBeenCalledWith({
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
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
      application,
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
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
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
    { mode: "off", restartRequired: false },
    { mode: "restart", restartRequired: false },
    { mode: "hot", restartRequired: false },
  ] as const)(
    "reports restartRequired=$restartRequired for $mode reload mode",
    async ({ mode, restartRequired }) => {
      managementMocks.setEnabled.mockResolvedValue({
        application,
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
      application,
      plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
    });

    await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "@openclaw/diffs",
      version: "1.2.3",
      acknowledgeCapabilities: { reviewToken },
    });

    expect(managementMocks.install).toHaveBeenCalledWith({
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
      request: {
        source: "clawhub",
        packageName: "@openclaw/diffs",
        version: "1.2.3",
        acknowledgeCapabilities: { reviewToken },
      },
    });
  });

  it.each([undefined, "latest", "1.0.0", "beta"])(
    "validates official version %s before forwarding policy and capability acknowledgements",
    async (version) => {
      managementMocks.install.mockResolvedValue({
        application,
        plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
      });

      await callHandler("plugins.install", {
        source: "official",
        pluginId: "diffs",
        ...(version ? { version } : {}),
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken },
      });

      expect(managementMocks.install).toHaveBeenCalledWith({
        applyRuntime: expect.any(Function),
        beforePersistentApply: expect.any(Function),
        request: {
          source: "official",
          pluginId: "diffs",
          ...(version ? { version } : {}),
          acknowledgeInstallPolicyWarning: true,
          acknowledgeCapabilities: { reviewToken },
        },
      });
    },
  );

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

  it("returns removal actions and the applied generation after uninstall", async () => {
    managementMocks.uninstall.mockResolvedValue({
      application,
      pluginId: "diffs",
      removed: ["config entry", "install record", "directory"],
      warnings: ["npm prune skipped"],
    });

    const result = await callHandler("plugins.uninstall", { pluginId: "diffs" });

    expect(managementMocks.uninstall).toHaveBeenCalledWith({
      pluginId: "diffs",
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
    });
    expect(result).toEqual({
      ok: true,
      response: {
        ok: true,
        pluginId: "diffs",
        restartRequired: false,
        runtime: application,
        removed: ["config entry", "install record", "directory"],
        warnings: ["npm prune skipped"],
      },
      error: undefined,
    });
  });

  it.each([
    {
      label: "directory removal",
      failure: () =>
        new ManagedPluginLifecycleError("Directory removal failed; retry uninstall", {
          kind: "unavailable",
        }),
    },
    { label: "config persistence", failure: () => new Error("Config write failed") },
    { label: "delegated authority", failure: () => new Error("Delegated authority closed") },
  ])("preserves the committed uninstall receipt after $label fails", async ({ failure }) => {
    const error = failure();
    const change = {
      config: { plugins: { entries: { workboard: { enabled: false } } } },
      pluginIds: ["workboard"],
      reason: "uninstall" as const,
    };
    managementMocks.uninstall.mockImplementation(
      async (
        params: Parameters<
          typeof import("../../plugins/management-mutations.js").uninstallManagedPlugin
        >[0],
      ) => {
        await params.applyRuntime?.(change);
        throw error;
      },
    );

    const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });

    expect(applyRuntime).toHaveBeenCalledExactlyOnceWith({
      ...change,
      assertInvokerOwned: expect.any(Function),
    });
    expect(result).toEqual({
      ok: false,
      response: undefined,
      error: {
        code: "UNAVAILABLE",
        message: `${error.message}\nAn earlier runtime change from this operation was applied in Gateway generation 42.`,
        details: { runtime: { ...application, committed: true } },
      },
    });
  });

  it.each([false, true])(
    "reports the latest publication after a second uninstall apply fails with committed=%s",
    async (committed) => {
      const details = {
        operationId: "second-operation",
        generation: committed ? 43 : 42,
        pluginIds: ["workboard"],
        phase: committed ? ("dispose" as const) : ("prepare" as const),
        committed,
      };
      const error = new PluginRuntimeApplicationError(
        "Final uninstall replacement failed",
        details,
      );
      applyRuntime.mockResolvedValueOnce(application).mockRejectedValueOnce(error);
      const changes = [
        {
          config: { plugins: { entries: { workboard: { enabled: false } } } },
          pluginIds: ["workboard"],
          reason: "uninstall" as const,
        },
        { config: {}, pluginIds: ["workboard"], reason: "uninstall" as const },
      ];
      managementMocks.uninstall.mockImplementation(
        async (
          params: Parameters<
            typeof import("../../plugins/management-mutations.js").uninstallManagedPlugin
          >[0],
        ) => {
          for (const change of changes) {
            await params.applyRuntime?.(change);
          }
        },
      );

      const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });

      expect(applyRuntime).toHaveBeenCalledTimes(2);
      expect(applyRuntime).toHaveBeenNthCalledWith(1, {
        ...changes[0],
        assertInvokerOwned: expect.any(Function),
      });
      expect(applyRuntime).toHaveBeenNthCalledWith(2, {
        ...changes[1],
        assertInvokerOwned: expect.any(Function),
      });
      expect(result).toEqual({
        ok: false,
        response: undefined,
        error: {
          code: "UNAVAILABLE",
          message: committed
            ? error.message
            : `${error.message}\nAn earlier runtime change from this operation was applied in Gateway generation 42.`,
          details: committed
            ? { runtime: details }
            : { runtime: { ...application, committed: true }, runtimeAttempt: details },
        },
      });
    },
  );

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
