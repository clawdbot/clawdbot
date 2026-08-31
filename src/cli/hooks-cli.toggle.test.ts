// Hook command tests cover metadata config keys and missing-hook exit status.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { resolveConfiguredInternalHookNames } from "../hooks/configured.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { ExpectedCliError } from "./failure-output.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  buildWorkspaceHookStatus: vi.fn(),
  getRuntimeConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  requestExitAfterOneShotOutput: vi.fn(),
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveConfiguredAgentId: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  tryResolveLegacyCompatibilityAgentId: vi.fn(),
}));

const capture = createCliRuntimeCapture();
const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: readConfigMachineStateMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveConfiguredAgentId: mocks.resolveConfiguredAgentId,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId: mocks.tryResolveLegacyCompatibilityAgentId,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: OpenClawConfig }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));

vi.mock("../hooks/hooks-status.js", () => ({
  buildWorkspaceHookStatus: mocks.buildWorkspaceHookStatus,
}));

vi.mock("../hooks/policy.js", () => ({
  resolveHookEntries: (entries: unknown[]) => entries,
}));

vi.mock("../hooks/workspace.js", () => ({
  loadWorkspaceHookEntries: () => [],
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginDiagnosticsReport: () => ({ hooks: [] }),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  loadGatewayStartupPluginPlanWithMetadata: () => ({
    plan: { channelPluginIds: [], pluginIds: [] },
    metadataSnapshot: {},
  }),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: capture.defaultRuntime,
}));

vi.mock("./one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutput,
}));

vi.mock("./native-hook-relay-cli.js", () => ({
  runNativeHookRelayCli: vi.fn(),
}));

vi.mock("./plugins-install-command.js", () => ({
  runPluginInstallCommand: vi.fn(),
}));

vi.mock("./plugins-update-command.js", () => ({
  runPluginUpdateCommand: vi.fn(),
}));

const sourceConfig = {
  hooks: {
    internal: {
      enabled: true,
      entries: {
        "metadata-key": {
          env: { HOOK_ENV: "preserved" },
        },
      },
    },
  },
};

const hook: HookStatusEntry = {
  name: "display-name",
  description: "Hook with a metadata config-key override",
  source: "openclaw-workspace",
  filePath: "/tmp/openclaw-hook-workspace/HOOK.md",
  baseDir: "/tmp/openclaw-hook-workspace",
  handlerPath: "/tmp/openclaw-hook-workspace/handler.js",
  hookKey: "metadata-key",
  events: ["command:new"],
  unknownEvents: [],
  always: false,
  enabledByConfig: true,
  requirementsSatisfied: true,
  loadable: true,
  managedByPlugin: false,
  ...createEmptyInstallChecks(),
};

const report: HookStatusReport = {
  workspaceDir: "/tmp/openclaw-hook-workspace",
  managedHooksDir: "/tmp/openclaw-managed-hooks",
  hooks: [hook],
};

const { registerHooksCli } = await import("./hooks-cli.js");

function createHooksProgram(): Command {
  const program = new Command().enablePositionalOptions();
  registerHooksCli(program);
  return program;
}

function createGatewayTransportError(kind: "closed" | "timeout", code = 1006) {
  return new GatewayTransportError({
    kind,
    message:
      kind === "closed" ? `gateway closed (${code}): unavailable` : "gateway timeout after 1500ms",
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
    ...(kind === "closed" ? { code, reason: "unavailable" } : { timeoutMs: 1_500 }),
  });
}

function configureExplicitFleet() {
  const config = {
    ...sourceConfig,
    agents: {
      ownership: "explicit" as const,
      list: [
        { id: "main", workspace: "/tmp/openclaw-main-workspace" },
        { id: "research", workspace: "/tmp/openclaw-research-workspace" },
      ],
    },
  };
  mocks.getRuntimeConfig.mockReturnValue(config);
  mocks.listAgentIds.mockReturnValue(["main", "research"]);
  mocks.tryResolveLegacyCompatibilityAgentId.mockReturnValue(undefined);
  mocks.resolveDefaultAgentId.mockImplementation(() => {
    throw new Error("selection required");
  });
  mocks.resolveAgentWorkspaceDir.mockImplementation(
    (_config: unknown, agentId: string) => `/tmp/openclaw-${agentId}-workspace`,
  );
  return config;
}

describe("hooks CLI metadata config keys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capture.resetRuntimeCapture();
    mocks.callGateway.mockRejectedValue(createGatewayTransportError("closed"));
    mocks.buildWorkspaceHookStatus.mockReturnValue(report);
    mocks.getRuntimeConfig.mockReturnValue(sourceConfig);
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveConfiguredAgentId.mockImplementation(
      (_config: OpenClawConfig, agentId: string) => {
        if (!mocks.listAgentIds().includes(agentId)) {
          throw new Error(`Unknown agent id "${agentId}"`);
        }
        return agentId;
      },
    );
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-hook-workspace");
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.tryResolveLegacyCompatibilityAgentId.mockReturnValue("main");
    mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig, hash: "config-hash" });
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it.each([
    { action: "enable", identifier: "display-name", enabled: true },
    { action: "enable", identifier: "metadata-key", enabled: true },
    { action: "disable", identifier: "display-name", enabled: false },
    { action: "disable", identifier: "metadata-key", enabled: false },
  ])("$action resolves $identifier to its metadata config key", async (testCase) => {
    await createHooksProgram().parseAsync(["hooks", testCase.action, testCase.identifier], {
      from: "user",
    });

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "metadata-key": {
                env: { HOOK_ENV: "preserved" },
                enabled: testCase.enabled,
              },
            },
          },
        },
      },
      baseHash: "config-hash",
    });
    const writtenConfig = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig as OpenClawConfig;
    expect(resolveConfiguredInternalHookNames(writtenConfig)).toEqual(
      new Set(testCase.enabled ? ["metadata-key"] : []),
    );
    expect(capture.runtimeLogs.at(-1)).toContain("display-name");
    expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 0);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each(["key-first", "name-first"])(
    "prefers an exact hook name over a colliding config key (%s)",
    async (order) => {
      const exactNameHook: HookStatusEntry = {
        ...hook,
        name: "shared",
        hookKey: "metadata-key",
      };
      const collidingKeyHook: HookStatusEntry = {
        ...hook,
        name: "another-hook",
        hookKey: "shared",
      };
      mocks.buildWorkspaceHookStatus.mockReturnValue({
        ...report,
        hooks:
          order === "key-first"
            ? [collidingKeyHook, exactNameHook]
            : [exactNameHook, collidingKeyHook],
      });

      await createHooksProgram().parseAsync(["hooks", "disable", "shared"], {
        from: "user",
      });

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
        nextConfig: {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "metadata-key": {
                  env: { HOOK_ENV: "preserved" },
                  enabled: false,
                },
              },
            },
          },
        },
        baseHash: "config-hash",
      });
      expect(capture.runtimeLogs.at(-1)).toContain("shared");
    },
  );

  it.each([
    {
      identifier: "shared-name",
      hooks: [
        { ...hook, name: "shared-name", hookKey: "first-key" },
        { ...hook, name: "shared-name", hookKey: "second-key" },
      ],
    },
    {
      identifier: "shared-key",
      hooks: [
        { ...hook, name: "first-hook", hookKey: "shared-key" },
        { ...hook, name: "second-hook", hookKey: "shared-key" },
      ],
    },
  ])("rejects the ambiguous hook identifier $identifier without mutation", async (testCase) => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: testCase.hooks });

    await expect(
      createHooksProgram().parseAsync(["hooks", "disable", testCase.identifier], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toBe(
      `Error: Hook "${testCase.identifier}" is ambiguous; matches: ${testCase.hooks
        .map((candidate) => `${candidate.name} (${candidate.hookKey})`)
        .join(", ")}. Use a unique hook name or hook key.`,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("bounds ambiguous hook candidates", async () => {
    const hooks = Array.from({ length: 7 }, (_, index) => ({
      ...hook,
      name: "shared-name",
      hookKey: `key-${index + 1}`,
    }));
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks });

    await expect(
      createHooksProgram().parseAsync(["hooks", "disable", "shared-name"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toBe(
      'Error: Hook "shared-name" is ambiguous; matches: shared-name (key-1), shared-name (key-2), shared-name (key-3), shared-name (key-4), shared-name (key-5) (+2). Use a unique hook name or hook key.',
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each(["enable", "disable"])(
    "gives the recovery command for an unknown hook on %s",
    async (action) => {
      mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: [] });

      await expect(
        createHooksProgram().parseAsync(["hooks", action, "missing-hook"], { from: "user" }),
      ).rejects.toThrow("__exit__:1");

      expect(capture.runtimeErrors.at(-1)).toBe(
        'Error: Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
      );
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("names missing requirements and the available install route", async () => {
    const ineligibleHook: HookStatusEntry = {
      ...hook,
      requirementsSatisfied: false,
      loadable: false,
      blockedReason: "missing requirements",
      missing: {
        bins: ["missing-bin"],
        anyBins: ["missing-any-a", "missing-any-b"],
        env: ["MISSING_ENV"],
        config: ["hooks.demo.enabled"],
        os: ["linux"],
      },
      install: [
        { id: "demo-npm", kind: "npm", label: "Install @openclaw/demo-hook (npm)", bins: [] },
      ],
    };
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: [ineligibleHook] });

    await expect(
      createHooksProgram().parseAsync(["hooks", "enable", "display-name"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toBe(
      'Error: Hook "display-name" is not eligible; missing bins: missing-bin; anyBins: missing-any-a, missing-any-b; env: MISSING_ENV; config: hooks.demo.enabled; os: linux. Install options: Install @openclaw/demo-hook (npm). Run `openclaw hooks info display-name` for details.',
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  describe.each(["human", "leaf JSON", "parent JSON"])("info selection (%s)", (output) => {
    const json = output !== "human";
    const argv = (identifier: string) => [
      "hooks",
      ...(output === "parent JSON" ? ["--json"] : []),
      "info",
      identifier,
      ...(output === "leaf JSON" ? ["--json"] : []),
    ];
    const exactNameHook = { ...hook, name: "shared" };
    const collidingKeyHook = { ...hook, name: "another-hook", hookKey: "shared" };

    it.each([
      {
        label: "key before name",
        hooks: [collidingKeyHook, exactNameHook],
        identifier: "shared",
        selected: exactNameHook,
      },
      {
        label: "name before key",
        hooks: [exactNameHook, collidingKeyHook],
        identifier: "shared",
        selected: exactNameHook,
      },
      { label: "unique key alias", hooks: [hook], identifier: "metadata-key", selected: hook },
      {
        label: "plugin-managed hook",
        hooks: [
          { ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" },
        ],
        identifier: "metadata-key",
        selected: hook,
      },
      {
        label: "ineligible hook",
        hooks: [{ ...hook, requirementsSatisfied: false, loadable: false }],
        identifier: "metadata-key",
        selected: hook,
      },
    ])("inspects $label without mutation", async ({ hooks, identifier, selected }) => {
      mocks.callGateway.mockResolvedValue({ ...report, hooks });

      await createHooksProgram().parseAsync(argv(identifier), { from: "user" });

      expect(capture.runtimeLogs).toHaveLength(1);
      if (json) {
        expect(JSON.parse(capture.runtimeLogs[0] ?? "")).toMatchObject({
          name: selected.name,
          hookKey: selected.hookKey,
        });
        expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledOnce();
      } else {
        expect(capture.runtimeLogs[0]).toContain(`${selected.name} `);
        expect(capture.runtimeLogs[0]).not.toContain("another-hook");
        expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
      }
      expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 0);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(capture.runtimeErrors).toEqual([]);
    });

    it("rejects an ambiguous key instead of reporting a successful inspection", async () => {
      mocks.callGateway.mockResolvedValue({
        ...report,
        hooks: [
          { ...hook, name: "first-hook", hookKey: "shared-key" },
          { ...hook, name: "second-hook", hookKey: "shared-key" },
        ],
      });

      await expect(
        createHooksProgram().parseAsync(argv("shared-key"), { from: "user" }),
      ).rejects.toMatchObject({
        name: "ExpectedCliError",
        message:
          'Hook "shared-key" is ambiguous; matches: first-hook (shared-key), second-hook (shared-key). Use a unique hook name or hook key.',
      });
      expect(capture.runtimeLogs).toEqual([]);
      expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    });

    it("preserves missing-hook output and requests a failing exit", async () => {
      await createHooksProgram().parseAsync(argv("missing-hook"), { from: "user" });

      expect(capture.runtimeLogs).toHaveLength(1);
      if (json) {
        expect(JSON.parse(capture.runtimeLogs[0] ?? "")).toEqual({
          ok: false,
          error: { type: "cli_error", message: 'Hook "missing-hook" not found.' },
          hook: "missing-hook",
        });
        expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledOnce();
      } else {
        expect(capture.runtimeLogs[0]).toBe(
          'Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
        );
        expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
      }
      expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 1);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    });
  });

  it.each(["enable", "disable"])("still rejects %s for plugin-managed hooks", async (action) => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [
        { ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" },
      ],
    });
    await expect(
      createHooksProgram().parseAsync(["hooks", action, "metadata-key"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.at(-1)).toContain('managed by plugin "demo-plugin"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("allows disabling a hook with missing requirements", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [{ ...hook, requirementsSatisfied: false, loadable: false }],
    });
    await createHooksProgram().parseAsync(["hooks", "disable", "metadata-key"], { from: "user" });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        hooks: {
          internal: {
            enabled: true,
            entries: { "metadata-key": { env: { HOOK_ENV: "preserved" }, enabled: false } },
          },
        },
      },
      baseHash: "config-hash",
    });
  });

  it.each([
    {
      label: "bare report with parent JSON",
      argv: ["hooks", "--agent", "retired", "--json"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "list with leaf JSON",
      argv: ["hooks", "list", "--agent", "retired", "--json"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "list with parent JSON",
      argv: ["hooks", "--json", "list", "--agent", "retired"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "info report",
      argv: ["hooks", "info", "display-name", "--agent", "retired", "--json"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "info report with parent JSON",
      argv: ["hooks", "--json", "info", "display-name", "--agent", "retired"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "check report",
      argv: ["hooks", "check", "--agent", "retired", "--json"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "check report with parent JSON",
      argv: ["hooks", "--json", "check", "--agent", "retired"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "blank leaf agent",
      argv: ["hooks", "list", "--agent", "", "--json"],
      message: "--agent must not be blank",
      phase: "agent",
    },
    {
      label: "human report",
      argv: ["hooks", "list", "--agent", "retired"],
      message: 'Unknown agent id "retired"',
      phase: "agent",
    },
    {
      label: "config loading",
      argv: ["hooks", "list", "--json"],
      message: "injected config loading failure",
      phase: "config",
    },
    {
      label: "authoritative Gateway report",
      argv: ["hooks", "check", "--json"],
      message: "injected Gateway report failure",
      phase: "gateway",
    },
    {
      label: "local report fallback",
      argv: ["hooks", "info", "display-name", "--json"],
      message: "injected local hook report failure",
      phase: "report",
    },
  ])("propagates $label failures to the root CLI renderer", async (testCase) => {
    if (testCase.phase === "config") {
      mocks.getRuntimeConfig.mockImplementation(() => {
        throw new Error(testCase.message);
      });
    }
    if (testCase.phase === "gateway") {
      mocks.callGateway.mockRejectedValue(
        new GatewayClientRequestError({ code: "INVALID_REQUEST", message: testCase.message }),
      );
    }
    if (testCase.phase === "report") {
      mocks.buildWorkspaceHookStatus.mockImplementation(() => {
        throw new Error(testCase.message);
      });
    }

    const execution = createHooksProgram().parseAsync(testCase.argv, { from: "user" });
    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message: testCase.message,
      humanOutput: `Error: ${testCase.message}`,
      machineOutput: testCase.message,
    });

    expect(capture.defaultRuntime.error).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    if (testCase.phase === "agent" || testCase.phase === "config") {
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    }
    if (testCase.phase === "agent") {
      expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    }
    if (testCase.phase === "gateway") {
      expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    }
  });

  it("preserves an existing expected read failure for root rendering", async () => {
    const failure = new ExpectedCliError({
      message: "existing root failure",
      humanOutput: "already styled failure",
      machineOutput: "machine failure",
    });
    mocks.getRuntimeConfig.mockImplementation(() => {
      throw failure;
    });

    await expect(
      createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" }),
    ).rejects.toBe(failure);
    expect(capture.defaultRuntime.error).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("emits the default hooks report as JSON", async () => {
    await createHooksProgram().parseAsync(["hooks", "--json"], { from: "user" });

    const payload = JSON.parse(String(capture.runtimeLogs.at(-1))) as {
      hooks?: Array<{ name?: string }>;
    };
    expect(payload.hooks).toEqual([expect.objectContaining({ name: "display-name" })]);
    expect(capture.runtimeLogs).toHaveLength(1);
    expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 0);
    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["default", ["hooks", "--json"]],
    ["list", ["hooks", "list", "--json"]],
    ["info", ["hooks", "info", "display-name", "--json"]],
    ["check", ["hooks", "check", "--json"]],
  ])("uses hooks.status for the %s read command", async (_label, argv) => {
    mocks.callGateway.mockResolvedValue({ ...report, workspaceDir: "/gateway/workspace" });
    mocks.buildWorkspaceHookStatus.mockClear();

    await createHooksProgram().parseAsync(argv, { from: "user" });

    expect(mocks.getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: sourceConfig,
      method: "hooks.status",
      params: { agentId: "main" },
      timeoutMs: 1_500,
      clientName: "cli",
      mode: "cli",
    });
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
  });

  const explicitGatewayHookFailures = [
    {
      label: "configured remote missing URL",
      config: { ...sourceConfig, gateway: { mode: "remote" as const } },
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
    },
    {
      label: "configured remote transport failure",
      config: {
        ...sourceConfig,
        gateway: { mode: "remote" as const, remote: { url: "ws://127.0.0.1:9" } },
      },
      message: "Gateway not reachable: ws://127.0.0.1:9",
    },
    {
      label: "configured remote auth failure",
      config: { ...sourceConfig, gateway: { mode: "remote" as const } },
      message: "gateway authentication failed",
    },
    {
      label: "configured remote unsupported method",
      config: { ...sourceConfig, gateway: { mode: "remote" as const } },
      message: "unknown method: hooks.status",
      unsupported: true,
    },
    {
      label: "environment-selected transport failure",
      config: sourceConfig,
      url: "ws://127.0.0.1:9",
      message: "Gateway not reachable: ws://127.0.0.1:9",
    },
    {
      label: "environment-selected auth failure",
      config: sourceConfig,
      url: "ws://127.0.0.1:9",
      message: "gateway authentication failed",
    },
    {
      label: "environment-selected unsupported method",
      config: sourceConfig,
      url: "ws://127.0.0.1:9",
      message: "unknown method: hooks.status",
      unsupported: true,
    },
  ];
  const hookReadCommands = [
    { label: "default", argv: ["hooks"] },
    { label: "list", argv: ["hooks", "list"] },
    { label: "info", argv: ["hooks", "info", "display-name"] },
    { label: "check", argv: ["hooks", "check"] },
  ];

  it.each(
    explicitGatewayHookFailures.flatMap((target) =>
      hookReadCommands.flatMap((command) =>
        [false, true].map((json) => ({
          target,
          command,
          json,
          label: `${command.label} ${json ? "JSON" : "human"}: ${target.label}`,
        })),
      ),
    ),
  )("does not substitute local hooks after $label", async ({ target, command, json }) => {
    mocks.getRuntimeConfig.mockReturnValue(target.config);
    if (target.url) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", target.url);
    }
    const error = target.unsupported
      ? new GatewayClientRequestError({ code: "INVALID_REQUEST", message: target.message })
      : new Error(target.message);
    mocks.callGateway.mockRejectedValue(error);

    const failure = await createHooksProgram()
      .parseAsync([...command.argv, ...(json ? ["--json"] : [])], { from: "user" })
      .then(
        () => undefined,
        (caughtError: unknown) => caughtError,
      );
    expect(failure).toMatchObject({
      name: "ExpectedCliError",
      message: target.message,
    });

    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "request validation",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: 'invalid hooks.status params: unknown agent id "retired"',
      }),
    },
    {
      label: "internal server failure",
      error: new GatewayClientRequestError({
        code: "INTERNAL_ERROR",
        message: "hook inventory crashed",
      }),
    },
    { label: "pairing close", error: createGatewayTransportError("closed", 1008) },
    { label: "authentication rotation", error: createGatewayTransportError("closed", 4001) },
    { label: "plain pairing close", error: new Error("gateway closed (1008): pairing required") },
    {
      label: "plain authentication close",
      error: new Error("gateway closed (4001): auth changed"),
    },
    { label: "unknown failure", error: new Error("gateway unavailable") },
  ])("does not substitute implicit-local hooks after $label", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);

    await expect(
      createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" }),
    ).rejects.toMatchObject({ message: error.message });

    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing credentials before connecting",
      error: Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
        method: "hooks.status",
        configPath: "/tmp/openclaw.json",
      }),
    },
    { label: "typed timeout", error: createGatewayTransportError("timeout") },
    { label: "pending-request close", error: new Error("gateway closed (1006): abnormal closure") },
    { label: "pending-request timeout", error: new Error("gateway timeout after 1500ms") },
  ])("retains implicit-local hook discovery after $label", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);

    await createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" });

    expect(mocks.buildWorkspaceHookStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ["list", ["hooks", "list", "--agent", "research", "--json"]],
    ["info", ["hooks", "info", "display-name", "--agent", "research", "--json"]],
    ["check", ["hooks", "check", "--agent", "research", "--json"]],
  ])("passes the explicit agent to hooks.status for %s", async (_label, argv) => {
    mocks.listAgentIds.mockReturnValue(["main", "research"]);
    mocks.callGateway.mockResolvedValue({ ...report, workspaceDir: "/gateway/research" });

    await createHooksProgram().parseAsync(argv, { from: "user" });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ params: { agentId: "research" } }),
    );
  });

  it("passes a parent --agent to the default and list read forms", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "research"]);
    mocks.callGateway.mockResolvedValue({ ...report, workspaceDir: "/gateway/research" });

    await createHooksProgram().parseAsync(["hooks", "--agent", "research", "--json"], {
      from: "user",
    });
    await createHooksProgram().parseAsync(["hooks", "--agent", "research", "list", "--json"], {
      from: "user",
    });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.callGateway.mock.calls) {
      expect(call).toEqual(expect.objectContaining({ params: { agentId: "research" } }));
    }
  });

  it.each([
    ["enable", ["hooks", "--agent", "research", "enable", "display-name"], true],
    ["enable", ["hooks", "enable", "display-name", "--agent", "research"], true],
    ["disable", ["hooks", "--agent", "research", "disable", "display-name"], false],
    ["disable", ["hooks", "disable", "display-name", "--agent", "research"], false],
  ])("uses --agent for %s hook discovery", async (_label, argv, enabled) => {
    const explicitFleet = configureExplicitFleet();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: explicitFleet,
      hash: "config-hash",
    });

    await createHooksProgram().parseAsync(argv, { from: "user" });

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        ...explicitFleet,
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "metadata-key": {
                env: { HOOK_ENV: "preserved" },
                enabled,
              },
            },
          },
        },
      },
      baseHash: "config-hash",
    });
  });

  it("leaves config unchanged when the selected hook agent is invalid", async () => {
    const explicitFleet = configureExplicitFleet();
    const initialConfig = structuredClone(explicitFleet);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: explicitFleet,
      hash: "config-hash",
    });

    await expect(
      createHooksProgram().parseAsync(["hooks", "enable", "display-name", "--agent", "retired"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toContain('Unknown agent id "retired"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(explicitFleet).toEqual(initialConfig);
  });

  it("rejects a blank parent hook agent before dispatching a subcommand", async () => {
    await expect(
      createHooksProgram().parseAsync(["hooks", "--agent", "", "list"], { from: "user" }),
    ).rejects.toThrow("--agent must not be blank");

    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("keeps the explicit owner in the offline hooks fallback", async () => {
    const explicitFleet = configureExplicitFleet();

    await createHooksProgram().parseAsync(["hooks", "list", "--agent", "research", "--json"], {
      from: "user",
    });

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    expect(mocks.buildWorkspaceHookStatus).toHaveBeenCalledWith(
      "/tmp/openclaw-research-workspace",
      expect.anything(),
    );
  });

  it("does not replace an authoritative Gateway ownership error with a local report", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: 'unknown agent id "retired"',
    });
    mocks.callGateway.mockRejectedValue(error);

    await expect(
      createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" }),
    ).rejects.toMatchObject({
      name: "ExpectedCliError",
      message: 'unknown agent id "retired"',
    });

    expect(capture.runtimeErrors).toEqual([]);
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
  });

  it.each([
    "unknown method: hooks.status",
    "invalid hooks.status params: unexpected property agentId",
    "invalid hooks.status params: at root: unexpected property 'agentId'",
  ])("uses the selected local fallback for an older Gateway: %s", async (message) => {
    mocks.callGateway.mockRejectedValue(
      new GatewayClientRequestError({ code: "INVALID_REQUEST", message }),
    );

    await createHooksProgram().parseAsync(["hooks", "list", "--agent", "main", "--json"], {
      from: "user",
    });

    expect(mocks.buildWorkspaceHookStatus).toHaveBeenCalledWith(
      "/tmp/openclaw-hook-workspace",
      expect.anything(),
    );
  });
});
