import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(() => ({})),
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
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));

type BindingResolverTestPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> & {
  setup?: Pick<NonNullable<ChannelPlugin["setup"]>, "resolveBindingAccountId">;
};

function createBindingResolverTestPlugin(params: {
  id: ChannelId;
  config: Partial<ChannelPlugin["config"]>;
  resolveBindingAccountId?: NonNullable<ChannelPlugin["setup"]>["resolveBindingAccountId"];
}): BindingResolverTestPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      ...params.config,
    },
    ...(params.resolveBindingAccountId
      ? { setup: { resolveBindingAccountId: params.resolveBindingAccountId } }
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
      "telegram",
      createBindingResolverTestPlugin({ id: "telegram", config: { listAccountIds: () => [] } }),
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

describe("agents bind/unbind commands", () => {
  beforeAll(async () => {
    ({ agentsBindCommand, agentsBindingsCommand, agentsUnbindCommand } =
      await loadFreshAgentsBindCommandModuleForTest());
  });

  beforeEach(() => {
    resetAgentsBindTestHarness();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockClear();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
  });

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

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("main <- matrix"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("ops <- telegram accountId=work"),
    );
  });

  it("binds routes to default agent when --agent is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["telegram"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ type: "route", agentId: "main", match: { channel: "telegram" } }],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("binds manifest-known external channels without loading plugin runtime", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["external-chat:work"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          {
            type: "route",
            agentId: "main",
            match: { channel: "external-chat", accountId: "work" },
          },
        ],
      }),
    );
    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ agentId: "main", match: { channel: "matrix" } }],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
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
});
