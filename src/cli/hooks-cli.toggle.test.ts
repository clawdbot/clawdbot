// Hook command tests cover metadata config keys and missing-hook exit status.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredInternalHookNames } from "../hooks/configured.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
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
  events: [],
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
  beforeEach(() => {
    vi.clearAllMocks();
    capture.resetRuntimeCapture();
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
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

    expect(capture.runtimeErrors.at(-1)).toContain(
      `Hook "${testCase.identifier}" is ambiguous; use a unique hook name or hook key`,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("preserves machine-readable missing-hook output and requests a failing exit", async () => {
    await createHooksProgram().parseAsync(["hooks", "info", "missing-hook", "--json"], {
      from: "user",
    });

    expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining('"error": "not found"'),
    );
    expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 1);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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
    const error = Object.assign(new Error('unknown agent id "retired"'), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    mocks.callGateway.mockRejectedValue(error);

    await expect(
      createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toContain('unknown agent id "retired"');
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
  });

  it.each([
    "unknown method: hooks.status",
    "invalid hooks.status params: unexpected property agentId",
  ])("uses the selected local fallback for an older Gateway: %s", async (message) => {
    mocks.callGateway.mockRejectedValue(
      Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
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
