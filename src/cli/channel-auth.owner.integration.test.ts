// Exercise Commander, auth dispatch, and actual owner resolution with local I/O seams.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerChannelsCli } from "./channels-cli.js";

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  registered: true,
  login: vi.fn(),
  logout: vi.fn(async () => ({ cleared: false })),
  catalog: vi.fn<(...args: unknown[]) => ChannelPluginCatalogEntry[]>(() => []),
  loadScoped: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
vi.mock("../commands/config-validation.js", () => ({
  requireValidConfigFileSnapshot: async () => ({ sourceConfig: fixture.config, hash: "fixture" }),
}));
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({ config, changes: [] }),
}));
vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: fixture.catalog,
  getChannelPluginCatalogEntry: () => undefined,
}));
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: (id: string) => id,
  getLoadedChannelPlugin: () => (fixture.registered ? plugin : undefined),
  listChannelPlugins: () => [plugin],
}));
vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  loadChannelSetupPluginRegistrySnapshotForChannel: fixture.loadScoped,
  ensureChannelSetupPluginInstalled: vi.fn(),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: async () => {
    throw new Error("isolated fixture has no Gateway");
  },
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: fixture.runtime,
  ExitError: class extends Error {},
}));

const plugin = {
  id: "fixture-chat",
  auth: { login: fixture.login },
  gateway: { logoutAccount: fixture.logout },
  config: {
    listAccountIds: () => ["work"],
    resolveAccount: () => ({ accountId: "work" }),
  },
};

async function runAuth(mode: string, parent: string[] = [], leaf: string[] = []) {
  const args = ["channels", ...parent, mode, ...leaf, "--channel", plugin.id, "--account", "work"];
  const program = new Command()
    .name("openclaw")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
}

describe.each(["login", "logout"])("channels %s owner", (mode) => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.registered = true;
    fixture.config = {
      agents: {
        ownership: "explicit",
        entries: {
          research: { workspace: "/tmp/research-workspace" },
          ops: { workspace: "/tmp/ops-workspace" },
        },
      },
    };
    fixture.catalog.mockReturnValue([
      {
        id: plugin.id,
        pluginId: plugin.id,
        origin: "bundled",
        meta: {
          id: plugin.id,
          label: "Fixture",
          selectionLabel: "Fixture",
          docsPath: "",
          blurb: "",
        },
        install: { npmSpec: "fixture-chat" },
      },
    ]);
    fixture.loadScoped.mockReturnValue({ channels: [{ plugin }], channelSetups: [] });
  });

  it.each([
    { name: "parent", parent: ["--agent", "ops"], leaf: [], owner: "ops" },
    { name: "leaf", parent: [], leaf: ["--agent", "ops"], owner: "ops" },
    {
      name: "leaf overrides parent",
      parent: ["--agent", "research"],
      leaf: ["--agent", "ops"],
      owner: "ops",
    },
    { name: "System Agent", parent: [], leaf: [], owner: "research" },
    { name: "trimmed explicit", parent: ["--agent", " ops "], leaf: [], owner: "ops" },
    { name: "explicit before System Agent", parent: ["--agent", "ops"], leaf: [], owner: "ops" },
  ])("retains the $name owner through plugin discovery", async ({ parent, leaf, owner, name }) => {
    if (name === "System Agent") {
      fixture.config.agents!.defaults = { systemAgent: { agentId: "research" } };
    } else if (name === "explicit before System Agent") {
      fixture.config.agents!.defaults = { systemAgent: { agentId: "???" } };
    }
    fixture.registered = false;

    await runAuth(mode, parent, leaf);

    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(fixture.loadScoped).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: `/tmp/${owner}-workspace` }),
    );
    expect(mode === "login" ? fixture.login : fixture.logout).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "work" }),
    );
  });

  it("does not require discovery to reload an already registered plugin", async () => {
    await runAuth(mode, ["--agent", "ops"]);

    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(fixture.catalog).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
    );
    expect(fixture.loadScoped).not.toHaveBeenCalled();
    expect(mode === "login" ? fixture.login : fixture.logout).toHaveBeenCalled();
  });

  it("keeps an ownerless fleet from reaching either auth action", async () => {
    await runAuth(mode);

    expect(fixture.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("no explicit owner"),
    );
    expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.login).not.toHaveBeenCalled();
    expect(fixture.logout).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "missing", error: 'Unknown agent id "missing"' },
    { agent: " ", error: "--agent must not be blank" },
  ])("rejects invalid explicit agent '$agent' before discovery", async ({ agent, error }) => {
    fixture.config.agents!.defaults = { systemAgent: { agentId: "research" } };

    await runAuth(mode, ["--agent", agent]);

    expect(fixture.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.login).not.toHaveBeenCalled();
    expect(fixture.logout).not.toHaveBeenCalled();
  });

  it("rejects a stale configured System Agent before discovery", async () => {
    fixture.config.agents!.defaults = { systemAgent: { agentId: "missing" } };

    await runAuth(mode);

    expect(fixture.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown agent id "missing"'),
    );
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it.each(["???", "OPS"])(
    "rejects explicit owner %s instead of normalizing it into another agent",
    async (agent) => {
      fixture.config.agents!.entries = {
        main: { workspace: "/tmp/main-workspace" },
        ops: { workspace: "/tmp/ops-workspace" },
      };
      await runAuth(mode, ["--agent", agent]);

      expect(fixture.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(`Unknown agent id "${agent}"`),
      );
      expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
      expect(fixture.catalog).not.toHaveBeenCalled();
      expect(fixture.login).not.toHaveBeenCalled();
      expect(fixture.logout).not.toHaveBeenCalled();
    },
  );

  it("keeps the legacy owner when the configured System Agent is unused", async () => {
    fixture.config.agents!.ownership = undefined;
    fixture.config.agents!.entries!.research!.default = true;
    fixture.config.agents!.defaults = { systemAgent: { agentId: "???" } };

    await runAuth(mode);

    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(fixture.catalog).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/research-workspace" }),
    );
    expect(mode === "login" ? fixture.login : fixture.logout).toHaveBeenCalled();
  });
});
