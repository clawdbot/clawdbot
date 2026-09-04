// Directory CLI tests cover directory command registration and plugin-backed lookups.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nullChannelDirectorySelf } from "../channels/plugins/directory-adapters.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { registerDirectoryCli } from "./directory-cli.js";

const runtimeState = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi, { exitPrefix: "exit" });
});

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getScopedChannelsCommandSecretTargets: vi.fn(() => ({
    targetIds: new Set(["channels.slack.botToken"]),
    allowedPaths: new Set(["channels.slack.botToken"]),
  })),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("./command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
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

function firstRecordArg(mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return requireRecord(mockCall(mockFn)[0]);
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
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot({ channels: {} }),
      hash: "config-1",
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
    }));
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "demo-channel",
      plugin: { id: "demo-channel" },
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
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "DIRECTORY_TEST_SLACK_TOKEN",
    } as const;
    const sourceConfig = { channels: { slack: { botToken: tokenRef } } };
    let runtimeConfig = {
      ...sourceConfig,
      messages: { responsePrefix: "runtime-default" },
    };
    let postWriteRuntimeConfig = runtimeConfig;
    mocks.loadConfig.mockImplementation(() => runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
      hash: "config-1",
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: {
        ...config,
        channels: { slack: { botToken: "resolved-directory-token" } },
      },
      diagnostics: [],
    }));
    const self = vi.fn().mockResolvedValue({ id: "self-1", name: "Family Phone" });
    mocks.resolveInstallableChannelPlugin.mockImplementation(async ({ cfg }) => ({
      cfg: {
        ...cfg,
        plugins: { entries: { slack: { enabled: true } } },
      },
      channelId: "slack",
      plugin: { id: "slack", directory: { self } },
      configChanged: true,
      pluginInstalled: true,
    }));
    mocks.replaceConfigFile.mockImplementation(async ({ nextConfig }) => {
      postWriteRuntimeConfig = {
        ...nextConfig,
        messages: { responsePrefix: "runtime-default" },
      };
      runtimeConfig = postWriteRuntimeConfig;
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--channel", "slack", "--json"], {
      from: "user",
    });

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const installArgs = firstRecordArg(mocks.resolveInstallableChannelPlugin);
    expect(installArgs.rawChannel).toBe("slack");
    expect(installArgs.allowInstall).toBe(true);
    expect(installArgs.preferRegisteredPlugin).toBe(true);
    expect(installArgs.cfg).toEqual(sourceConfig);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const replaceArgs = firstRecordArg(mocks.replaceConfigFile);
    expect(replaceArgs.nextConfig).toEqual({
      channels: { slack: { botToken: tokenRef } },
      plugins: { entries: { slack: { enabled: true } } },
    });
    expect(replaceArgs.nextConfig).not.toHaveProperty("messages");
    expect(replaceArgs.baseHash).toBe("config-1");
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledOnce();
    expect(firstRecordArg(mocks.resolveCommandSecretRefsViaGateway)).toMatchObject({
      config: postWriteRuntimeConfig,
      commandName: "directory",
      targetIds: new Set(["channels.slack.botToken"]),
      allowedPaths: new Set(["channels.slack.botToken"]),
      mode: "read_only_operational",
    });
    expect(self).toHaveBeenCalledTimes(1);
    expect(firstRecordArg(self).accountId).toBe("default");
    expect(firstRecordArg(self).cfg).toEqual({
      ...postWriteRuntimeConfig,
      channels: { slack: { botToken: "resolved-directory-token" } },
    });
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
  });

  it.each([
    ["self", ["directory", "self", "--channel", "slack", "--json"]],
    ["peers", ["directory", "peers", "list", "--channel", "slack", "--json"]],
    ["groups", ["directory", "groups", "list", "--channel", "slack", "--json"]],
    [
      "group members",
      ["directory", "groups", "members", "--channel", "slack", "--group-id", "group-1", "--json"],
    ],
  ])("stops %s when canonical config validation exits", async (_label, args) => {
    const directory = {
      self: vi.fn().mockResolvedValue({ id: "self-1" }),
      listPeersLive: vi.fn().mockResolvedValue([]),
      listGroupsLive: vi.fn().mockResolvedValue([]),
      listGroupMembers: vi.fn().mockResolvedValue([]),
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/invalid-openclaw.json",
      exists: true,
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
      config: {},
      issues: [{ path: "channels.slack", message: "invalid Slack config" }],
      warnings: [],
      legacyIssues: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      plugin: { id: "slack", directory },
      configured: ["slack"],
      source: "explicit",
    });
    runtimeState.defaultRuntime.exit.mockImplementation(() => undefined);

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);
    await program.parseAsync(args, { from: "user" });

    expect(Object.values(directory).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.log).not.toHaveBeenCalled();
    expect(runtimeErrors()[0]).toContain("OpenClaw config is invalid");
    expect(runtimeState.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the auto-enabled config snapshot for omitted channel selection", async () => {
    const autoEnabledConfig = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    const self = vi.fn().mockResolvedValue({ id: "self-2", name: "WhatsApp Bot" });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["whatsapp"],
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      mocks.loadConfig.mockReturnValue(autoEnabledConfig);
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      plugin: {
        id: "whatsapp",
        directory: { self },
      },
      configured: ["whatsapp"],
      source: "single-configured",
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
      accountResolution: "read_only",
    });
    expect(self).toHaveBeenCalledTimes(1);
    expect(firstRecordArg(self).cfg).toBe(autoEnabledConfig);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: autoEnabledConfig,
      baseHash: "config-1",
    });
  });

  it("inspects an implicit channel before resolving only that account's secrets", async () => {
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "DIRECTORY_TEST_SLACK_TOKEN",
    } as const;
    const sourceConfig = { channels: { slack: { botToken: tokenRef } } };
    const runtimeConfig = {
      ...sourceConfig,
      messages: { responsePrefix: "runtime-default" },
    };
    const calls: string[] = [];
    const self = vi.fn().mockImplementation(async () => {
      calls.push("directory");
      return { id: "U123", name: "Slack Bot" };
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
      hash: "config-1",
    });
    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.resolveMessageChannelSelection.mockImplementation(
      async ({ accountResolution }: { accountResolution?: string }) => {
        calls.push("selection");
        if (accountResolution !== "read_only") {
          throw new Error("unresolved SecretRef");
        }
        return {
          channel: "slack",
          plugin: { id: "slack", directory: { self } },
          configured: ["slack"],
          source: "single-configured",
        };
      },
    );
    mocks.getScopedChannelsCommandSecretTargets.mockImplementationOnce(() => {
      calls.push("scope");
      return {
        targetIds: new Set(["channels.slack.botToken"]),
        allowedPaths: new Set(["channels.slack.botToken"]),
      };
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => {
      calls.push("secrets");
      return {
        resolvedConfig: {
          ...config,
          channels: { slack: { botToken: "resolved-directory-token" } },
        },
        diagnostics: [],
      };
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(["directory", "self", "--json"], { from: "user" });

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: runtimeConfig,
      channel: null,
      accountResolution: "read_only",
    });
    expect(mocks.getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: runtimeConfig,
      channel: "slack",
      accountId: "default",
    });
    expect(firstRecordArg(self).cfg).toEqual({
      ...runtimeConfig,
      channels: { slack: { botToken: "resolved-directory-token" } },
    });
    expect(calls).toEqual(["selection", "scope", "secrets", "directory"]);
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "human",
      args: ["directory", "self", "--channel", "demo-directory", "--account", "account-1"],
    },
    {
      mode: "JSON",
      args: [
        "directory",
        "self",
        "--channel",
        "demo-directory",
        "--account",
        "account-1",
        "--json",
      ],
    },
  ])("explains an empty implemented self lookup in $mode mode", async ({ mode, args }) => {
    const self = vi.fn().mockResolvedValue(null);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "demo-directory": {} } },
      channelId: "demo-directory",
      plugin: { id: "demo-directory", directory: { self } },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(args, { from: "user" });

    if (mode === "JSON") {
      expect(runtimeState.defaultRuntime.writeJson).toHaveBeenCalledWith({
        status: "unavailable",
        channel: "demo-directory",
        accountId: "account-1",
        reason: "plugin-returned-no-self-identity",
      });
    } else {
      const output = runtimeState.runtimeLogs.join("\n");
      expect(output).toBe(
        'No self identity was returned for channel "demo-directory", account "account-1". Verify the account is configured and authenticated, then retry.',
      );
    }
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "human",
      args: ["directory", "self", "--channel", "demo-directory", "--account", "account-1"],
    },
    {
      mode: "JSON",
      args: [
        "directory",
        "self",
        "--channel",
        "demo-directory",
        "--account",
        "account-1",
        "--json",
      ],
    },
  ])("explains an unsupported self lookup in $mode mode", async ({ mode, args }) => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "demo-directory": {} } },
      channelId: "demo-directory",
      plugin: {
        id: "demo-directory",
        directory: { self: nullChannelDirectorySelf },
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(args, { from: "user" });

    if (mode === "JSON") {
      expect(runtimeState.defaultRuntime.writeJson).toHaveBeenCalledWith({
        status: "unavailable",
        channel: "demo-directory",
        accountId: "account-1",
        reason: "self-identity-unsupported",
      });
    } else {
      expect(runtimeState.runtimeLogs.join("\n")).toBe(
        'Channel "demo-directory" does not expose a self identity.',
      );
    }
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
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
    const listPeersLiveArgs = firstRecordArg(listPeersLive);
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
    expect(firstRecordArg(listGroups).accountId).toBe("default");
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify([{ id: "channel:config", kind: "group" }], null, 2),
    );
  });

  it.each([
    {
      label: "peers",
      args: ["directory", "peers", "list", "--channel", "demo-directory", "--account", "account-1"],
      expected: "No peers found",
    },
    {
      label: "groups",
      args: [
        "directory",
        "groups",
        "list",
        "--channel",
        "demo-directory",
        "--account",
        "account-1",
      ],
      expected: "No groups found",
    },
    {
      label: "group members",
      args: [
        "directory",
        "groups",
        "members",
        "--channel",
        "demo-directory",
        "--account",
        "account-1",
        "--group-id",
        "group-1",
      ],
      expected: 'No group members found for group "group-1"',
    },
  ])("names the query context for empty $label", async ({ args, expected }) => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "demo-directory": {} } },
      channelId: "demo-directory",
      plugin: {
        id: "demo-directory",
        directory: {
          listPeers: vi.fn().mockResolvedValue([]),
          listGroups: vi.fn().mockResolvedValue([]),
          listGroupMembers: vi.fn().mockResolvedValue([]),
        },
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await program.parseAsync(args, { from: "user" });

    const output = runtimeState.runtimeLogs.join("\n");
    expect(output).toContain(expected);
    expect(output).toContain('channel "demo-directory"');
    expect(output).toContain('account "account-1"');
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("sanitizes plugin directory entries only for terminal output", async () => {
    const entry = {
      id: "user:\u001B]0;directory-id\u0007🦞\nforged-row",
      name: "Alice\u001B[31m\r\nadmin\tbadge",
    };
    const listPeers = vi.fn().mockResolvedValue([entry]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { slack: {} } },
      channelId: "slack",
      plugin: { id: "slack", directory: { listPeers } },
      configChanged: false,
    });

    const textProgram = new Command().name("openclaw");
    registerDirectoryCli(textProgram);
    await textProgram.parseAsync(["directory", "peers", "list", "--channel", "slack"], {
      from: "user",
    });

    const textOutput = runtimeState.defaultRuntime.log.mock.calls.flat().join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("\\nforged-row");
    expect(textOutput).toContain("\\r\\nadmin\\tbadge");
    expect(textOutput).toContain("🦞");

    runtimeState.defaultRuntime.writeJson.mockClear();
    const jsonProgram = new Command().name("openclaw");
    registerDirectoryCli(jsonProgram);
    await jsonProgram.parseAsync(["directory", "peers", "list", "--channel", "slack", "--json"], {
      from: "user",
    });

    expect(runtimeState.defaultRuntime.writeJson).toHaveBeenCalledWith([entry]);
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
    const installArgs = firstRecordArg(mocks.resolveInstallableChannelPlugin);
    expect(installArgs.rawChannel).toBe("openclaw-weixin");
    expect(installArgs.allowInstall).toBe(true);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(
      runtimeErrors().some((message) =>
        message.includes("Channel openclaw-weixin does not support directory peers"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "self",
      ["directory", "self", "--channel", "demo-directory", "--json"],
      "Channel demo-directory does not support directory self",
    ],
    [
      "peers",
      ["directory", "peers", "list", "--channel", "demo-directory", "--json"],
      "Channel demo-directory does not support directory peers",
    ],
    [
      "groups",
      ["directory", "groups", "list", "--channel", "demo-directory", "--json"],
      "Channel demo-directory does not support directory groups",
    ],
    [
      "group members",
      [
        "directory",
        "groups",
        "members",
        "--channel",
        "demo-directory",
        "--group-id",
        "group-1",
        "--json",
      ],
      "Channel demo-directory does not support group members listing",
    ],
  ])("bubbles JSON errors for unsupported directory %s", async (_label, args, expectedError) => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "demo-directory": {} } },
      channelId: "demo-directory",
      plugin: {
        id: "demo-directory",
        directory: {},
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(expectedError);

    expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "human", args: ["directory", "self", "--channel", "demo-directory"] },
    {
      mode: "JSON",
      args: ["directory", "self", "--channel", "demo-directory", "--json"],
    },
  ])("renders named errors without class names in $mode mode", async ({ mode, args }) => {
    const error = new Error("Multiple agents are configured, but this operation has no owner.");
    error.name = "AgentSelectionRequiredError";
    const self = vi.fn().mockRejectedValue(error);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "demo-directory": {} } },
      channelId: "demo-directory",
      plugin: { id: "demo-directory", directory: { self } },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    if (mode === "JSON") {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(error.message);
      expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
      expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
    } else {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("exit:1");
      expect(runtimeErrors()).toEqual([error.message]);
      expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(runtimeState.defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
    expect([...runtimeState.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(error.name);
  });

  it.each([
    ["peers list", ["directory", "peers", "list", "--channel", "slack", "--limit", "5x"]],
    ["groups list", ["directory", "groups", "list", "--channel", "slack", "--limit", "5x"]],
    [
      "group members",
      [
        "directory",
        "groups",
        "members",
        "--channel",
        "slack",
        "--group-id",
        "group-1",
        "--limit",
        "5x",
      ],
    ],
  ])("rejects partial directory limit for %s", async (_label, args) => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { slack: {} } },
      channelId: "slack",
      plugin: {
        id: "slack",
        directory: {
          listPeers: vi.fn().mockResolvedValue([]),
          listGroups: vi.fn().mockResolvedValue([]),
          listGroupMembers: vi.fn().mockResolvedValue([]),
        },
      },
      configChanged: false,
    });

    const program = new Command().name("openclaw");
    registerDirectoryCli(program);

    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow("exit:1");

    expect(runtimeErrors().join("\n")).toContain("--limit must be a positive integer.");
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });
});
