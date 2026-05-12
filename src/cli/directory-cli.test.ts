import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDirectoryCli } from "./directory-cli.js";

const runtimeState = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi, { exitPrefix: "exit" });
});

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../commands/channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeState.defaultRuntime,
}));

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    throw new Error("expected record");
  }
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function runtimeErrors(): string[] {
  return runtimeState.defaultRuntime.error.mock.calls.map(([message]) => String(message));
}

describe("registerDirectoryCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.runtimeLogs.length = 0;
    runtimeState.runtimeErrors.length = 0;
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "demo-channel",
      configured: ["demo-channel"],
      source: "explicit",
    });
    runtimeState.defaultRuntime.log.mockClear();
    runtimeState.defaultRuntime.error.mockClear();
    runtimeState.defaultRuntime.writeStdout.mockClear();
    runtimeState.defaultRuntime.writeJson.mockClear();
    runtimeState.defaultRuntime.exit.mockClear();
    runtimeState.defaultRuntime.exit.mockImplementation((code: number) => {
      throw new Error(`exit:${code}`);
    });
  });

  it("installs an explicit optional directory channel on demand", async () => {
    const self = vi.fn().mockResolvedValue({ id: "self-1", name: "Family Phone" });
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: {
        channels: {},
        plugins: { entries: { "demo-directory": { enabled: true } } },
      },
      channelId: "demo-directory",
      plugin: {
        id: "demo-directory",
        directory: { self },
      },
      configChanged: true,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--channel", "demo-directory", "--json"], {
      from: "user",
    });

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const installArgs = requireRecord(mocks.resolveInstallableChannelPlugin.mock.calls.at(0)?.[0]);
    expect(installArgs.rawChannel).toBe("demo-directory");
    expect(installArgs.allowInstall).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const replaceArgs = requireRecord(mocks.replaceConfigFile.mock.calls.at(0)?.[0]);
    expect(replaceArgs.nextConfig).toEqual({
      channels: {},
      plugins: { entries: { "demo-directory": { enabled: true } } },
    });
    expect(replaceArgs.baseHash).toBe("config-1");
    expect(self).toHaveBeenCalledTimes(1);
    expect(requireRecord(self.mock.calls.at(0)?.[0]).accountId).toBe("default");
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("uses the auto-enabled config snapshot for omitted channel selection", async () => {
    const autoEnabledConfig = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    const self = vi.fn().mockResolvedValue({ id: "self-2", name: "WhatsApp Bot" });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["whatsapp"],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      configured: ["whatsapp"],
      source: "single-configured",
    });
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      directory: { self },
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--json"], { from: "user" });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: { channels: {} },
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
      channel: null,
    });
    expect(self).toHaveBeenCalledTimes(1);
    expect(requireRecord(self.mock.calls.at(0)?.[0]).cfg).toBe(autoEnabledConfig);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: autoEnabledConfig,
      baseHash: "config-1",
    });
  });

  it("prefers live directory list readers when available", async () => {
    const listPeers = vi.fn().mockResolvedValue([{ id: "user:config", kind: "user" }]);
    const listPeersLive = vi.fn().mockResolvedValue([{ id: "user:live", kind: "user" }]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { slack: {} } },
      channelId: "slack",
      plugin: {
        id: "slack",
        directory: { listPeers, listPeersLive },
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(
      [
        "directory",
        "peers",
        "list",
        "--channel",
        "slack",
        "--query",
        "ada",
        "--limit",
        "5",
        "--json",
      ],
      { from: "user" },
    );

    expect(listPeersLive).toHaveBeenCalledTimes(1);
    const listPeersLiveArgs = requireRecord(listPeersLive.mock.calls.at(0)?.[0]);
    expect(listPeersLiveArgs.accountId).toBe("default");
    expect(listPeersLiveArgs.query).toBe("ada");
    expect(listPeersLiveArgs.limit).toBe(5);
    expect(listPeers).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify([{ id: "user:live", kind: "user" }], null, 2),
    );
  });

  it("falls back to config-backed directory list readers when live readers are absent", async () => {
    const listGroups = vi.fn().mockResolvedValue([{ id: "channel:config", kind: "group" }]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { slack: {} } },
      channelId: "slack",
      plugin: {
        id: "slack",
        directory: { listGroups },
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "groups", "list", "--channel", "slack", "--json"], {
      from: "user",
    });

    expect(listGroups).toHaveBeenCalledTimes(1);
    expect(requireRecord(listGroups.mock.calls.at(0)?.[0]).accountId).toBe("default");
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify([{ id: "channel:config", kind: "group" }], null, 2),
    );
  });

  it("reports unsupported directory capability instead of continuing setup for installed plugins", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "openclaw-weixin": {} } },
      channelId: "openclaw-weixin",
      plugin: {
        id: "openclaw-weixin",
      },
      configChanged: false,
      pluginInstalled: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await expect(
      program.parseAsync(["directory", "peers", "list", "--channel", "openclaw-weixin"], {
        from: "user",
      }),
    ).rejects.toThrow("exit:1");

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const installArgs = requireRecord(mocks.resolveInstallableChannelPlugin.mock.calls.at(0)?.[0]);
    expect(installArgs.rawChannel).toBe("openclaw-weixin");
    expect(installArgs.allowInstall).toBe(true);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(
      runtimeErrors().some((message) =>
        message.includes("Channel openclaw-weixin does not support directory peers"),
      ),
    ).toBe(true);
  });
});
