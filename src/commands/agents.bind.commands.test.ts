// Agent bind command tests cover channel bindings, plugin metadata, and command output.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  listPluginContributionIds: vi.fn(() => ["external-chat"]),
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: (
    cfg: {
      agents?: { list?: Array<{ id: string; default?: boolean }> };
    } | null,
  ) => cfg?.agents?.list ?? [],
  resolveDefaultAgentId: (
    cfg: {
      agents?: { list?: Array<{ id: string; default?: boolean }> };
    } | null,
  ) => cfg?.agents?.list?.find((agent) => agent.default)?.id ?? "main",
}));

vi.mock("../config/bindings.js", () => ({
  isRouteBinding: (binding: { match?: unknown }) => Boolean(binding.match),
  listRouteBindings: (cfg: { bindings?: Array<{ match?: unknown }> }) =>
    (cfg.bindings ?? []).filter((binding) => Boolean(binding.match)),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));

type BindingResolverTestPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> & {
  setup?: Pick<NonNullable<ChannelPlugin["setup"]>, "resolveBindingAccountId">;
  setupContract?: Pick<NonNullable<ChannelPlugin["setupContract"]>, "resolveBindingAccountId">;
};

function createBindingResolverTestPlugin(params: {
  id: ChannelId;
  config: Partial<ChannelPlugin["config"]>;
  resolveBindingAccountId?: NonNullable<ChannelPlugin["setup"]>["resolveBindingAccountId"];
  contractOnly?: boolean;
  forceAccountBinding?: boolean;
}): BindingResolverTestPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: "test stub.",
      ...(params.forceAccountBinding ? { forceAccountBinding: true } : {}),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      ...params.config,
    },
    ...(params.resolveBindingAccountId
      ? {
          [params.contractOnly ? "setupContract" : "setup"]: {
            resolveBindingAccountId: params.resolveBindingAccountId,
          },
        }
      : {}),
  };
}

vi.mock("../channels/plugins/index.js", () => {
  return {
    getLoadedChannelPlugin: () => undefined,
  };
});

vi.mock("../channels/plugins/bundled.js", () => {
  const knownChannels = new Map([
    [
      "discord",
      createBindingResolverTestPlugin({ id: "discord", config: { listAccountIds: () => [] } }),
    ],
    [
      "matrix",
      createBindingResolverTestPlugin({
        id: "matrix",
        config: { listAccountIds: () => [] },
        resolveBindingAccountId: ({ agentId }) => agentId.toLowerCase(),
      }),
    ],
    [
      "signal",
      createBindingResolverTestPlugin({
        id: "signal",
        config: { listAccountIds: () => [] },
        resolveBindingAccountId: ({ agentId }) => agentId.toLowerCase(),
        contractOnly: true,
      }),
    ],
    [
      "telegram",
      createBindingResolverTestPlugin({ id: "telegram", config: { listAccountIds: () => [] } }),
    ],
    [
      "whatsapp",
      createBindingResolverTestPlugin({
        id: "whatsapp",
        config: { listAccountIds: () => ["default", "biz"] },
        forceAccountBinding: true,
      }),
    ],
  ]);
  return {
    getBundledChannelSetupPlugin: (channel: string) => {
      const normalized = channel.trim().toLowerCase();
      return knownChannels.get(normalized);
    },
  };
});

let agentsBindCommand: typeof import("./agents.commands.bind.js").agentsBindCommand;
let agentsBindingsCommand: typeof import("./agents.commands.bind.js").agentsBindingsCommand;
let agentsUnbindCommand: typeof import("./agents.commands.bind.js").agentsUnbindCommand;

type JsonTestRuntime = RuntimeEnv & {
  writeStdout: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
};

function createJsonTestRuntime(): JsonTestRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

describe("agents bind/unbind commands", () => {
  beforeAll(async () => {
    ({ agentsBindCommand, agentsBindingsCommand, agentsUnbindCommand } =
      await loadFreshAgentsBindCommandModuleForTest());
  });

  beforeEach(() => {
    resetAgentsBindTestHarness();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
  });

  function firstWrittenConfig(): { bindings?: unknown } {
    const call = writeConfigFileMock.mock.calls[0];
    if (!call) {
      throw new Error("expected config write");
    }
    return call[0] as { bindings?: unknown };
  }

  it("lists all bindings by default", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        bindings: [
          { agentId: "main", match: { channel: "matrix" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsBindingsCommand({}, runtime);

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(runtime.log).toHaveBeenCalledWith(
      ["Routing bindings:", "- main <- matrix", "- ops <- telegram accountId=work"].join("\n"),
    );
  });

  it("binds routes to default agent when --agent is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["telegram"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = firstWrittenConfig();
    expect(writtenConfig?.bindings).toStrictEqual([
      { type: "route", agentId: "main", match: { channel: "telegram" } },
    ]);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(pluginRegistryMocks.listPluginContributionIds).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bindings with an unrepresentable agent",
      command: "bindings",
      options: { agent: "агент✨", json: true },
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bindings with an unknown agent",
      command: "bindings",
      options: { agent: "ghost", json: true },
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an unrepresentable agent",
      command: "bind",
      options: { agent: "агент✨", bind: ["telegram"], json: true },
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with a blank agent",
      command: "bind",
      options: { agent: "   ", bind: ["telegram"], json: true },
      message: 'Agent "   " not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an unknown agent before missing bindings",
      command: "bind",
      options: { agent: "ghost", json: true },
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind without bindings",
      command: "bind",
      options: { json: true },
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with only blank bindings",
      command: "bind",
      options: { bind: ["  "], json: true },
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with multiple malformed bindings in input order",
      command: "bind",
      options: { bind: ["telegram:", "telegram:work:extra"], json: true },
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
      ].join("\n"),
    },
    {
      name: "bind with an unknown channel",
      command: "bind",
      options: { bind: ["definitely-not-a-channel"], json: true },
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
      loadsPluginRegistry: true,
    },
    {
      name: "unbind with an unrepresentable agent",
      command: "unbind",
      options: { agent: "агент✨", all: true, json: true },
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind with an unknown agent before incompatible options",
      command: "unbind",
      options: { agent: "ghost", all: true, bind: ["telegram"], json: true },
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind without bindings",
      command: "unbind",
      options: { json: true },
      message: "Provide at least one --bind <channel[:accountId]> or use --all.",
    },
    {
      name: "unbind with only blank bindings",
      command: "unbind",
      options: { bind: ["  "], json: true },
      message: "Provide at least one --bind <channel[:accountId]> or use --all.",
    },
    {
      name: "unbind with incompatible all and binding options",
      command: "unbind",
      options: { all: true, bind: ["telegram"], json: true },
      message: "Use either --all or --bind, not both.",
    },
    {
      name: "unbind with a malformed binding",
      command: "unbind",
      options: { bind: ["telegram:work:extra"], json: true },
      message:
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
    },
  ])(
    "rejects $name through the root failure owner before mutation",
    async ({ command, options, message, loadsPluginRegistry }) => {
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: {},
      });

      const execution =
        command === "bindings"
          ? agentsBindingsCommand(options, runtime)
          : command === "bind"
            ? agentsBindCommand(options, runtime)
            : agentsUnbindCommand(options, runtime);

      await expect(execution).rejects.toMatchObject({
        name: "ExpectedCliError",
        message,
        humanOutput: message,
        machineOutput: message,
      });
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(writeConfigFileMock).not.toHaveBeenCalled();
      if (!loadsPluginRegistry) {
        expect(pluginRegistryMocks.listPluginContributionIds).not.toHaveBeenCalled();
      }
    },
  );

  it("uses a wildcard account binding for multi-account channels", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["whatsapp"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = firstWrittenConfig();
    expect(writtenConfig?.bindings).toStrictEqual([
      { type: "route", agentId: "main", match: { channel: "whatsapp", accountId: "*" } },
    ]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("resolves account bindings from channel-owned setup contracts", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["signal"] }, runtime);

    expect(firstWrittenConfig().bindings).toStrictEqual([
      { type: "route", agentId: "main", match: { channel: "signal", accountId: "main" } },
    ]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("binds manifest-known external channels without loading plugin runtime", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["external-chat:work", "external-chat:home"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = firstWrittenConfig();
    expect(writtenConfig?.bindings).toStrictEqual([
      {
        type: "route",
        agentId: "main",
        match: { channel: "external-chat", accountId: "work" },
      },
      {
        type: "route",
        agentId: "main",
        match: { channel: "external-chat", accountId: "home" },
      },
    ]);
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledOnce();
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledWith({
      contribution: "channels",
      includeDisabled: true,
      config: {},
      env: process.env,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    pluginRegistryMocks.listPluginContributionIds.mockReturnValueOnce([]);
    await expect(
      agentsBindCommand({ bind: ["external-chat:next"] }, runtime),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Unknown channel "external-chat"'),
    });
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledTimes(2);
  });

  it("unbinds all routes for an agent", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
        bindings: [
          { agentId: "main", match: { channel: "matrix" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsUnbindCommand({ agent: "ops", all: true }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = firstWrittenConfig();
    expect(writtenConfig?.bindings).toStrictEqual([
      { agentId: "main", match: { channel: "matrix" } },
    ]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports empty unbind-all as JSON without text logs", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });
    const jsonRuntime = createJsonTestRuntime();

    await agentsUnbindCommand({ agent: "main", all: true, json: true }, jsonRuntime);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(jsonRuntime.log).not.toHaveBeenCalled();
    expect(jsonRuntime.writeJson.mock.calls[0]?.[0]).toStrictEqual({
      agentId: "main",
      removed: [],
      missing: [],
      conflicts: [],
    });
    expect(jsonRuntime.exit).not.toHaveBeenCalled();
  });

  it("reports ownership conflicts during unbind and exits 1", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "ops" } }],
      },
    });

    await agentsUnbindCommand({ agent: "ops", bind: ["telegram:ops"] }, runtime);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Bindings are owned by another agent:");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each(["bind", "unbind"])(
    "preserves the post-decision %s conflict JSON result and exit status",
    async (command) => {
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: {
          agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
          bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "ops" } }],
        },
      });
      const jsonRuntime = createJsonTestRuntime();
      const options = { agent: "ops", bind: ["telegram:ops"], json: true };

      if (command === "bind") {
        await agentsBindCommand(options, jsonRuntime);
      } else {
        await agentsUnbindCommand(options, jsonRuntime);
      }

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(jsonRuntime.writeJson.mock.calls[0]?.[0]).toStrictEqual({
        agentId: "ops",
        ...(command === "bind"
          ? { added: [], updated: [], skipped: [] }
          : { removed: [], missing: [] }),
        conflicts: ["telegram accountId=ops (agent=main)"],
      });
      expect(jsonRuntime.error).not.toHaveBeenCalled();
      expect(jsonRuntime.exit).toHaveBeenCalledWith(1);
    },
  );
});
