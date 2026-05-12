import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCommandFlagEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { handleBashChatCommand } from "./bash-command.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({ valid: true, parsed: {} })),
);
const validateConfigObjectWithPluginsMock = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    config: {},
    issues: [],
  })),
);
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const getConfigOverridesMock = vi.hoisted(() => vi.fn(() => ({})));
const getConfigValueAtPathMock = vi.hoisted(() => vi.fn());
const parseConfigPathMock = vi.hoisted(() => vi.fn());
const setConfigValueAtPathMock = vi.hoisted(() => vi.fn());
const resolveConfigWriteDeniedTextMock = vi.hoisted(() =>
  vi.fn<(...args: never[]) => string | null>(() => null),
);
const isInternalMessageChannelMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "agent:main"),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getFinishedSession: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: vi.fn(),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    clampInt: vi.fn((value: number) => value),
  };
});

vi.mock("./mentions.js", () => ({
  stripMentions: vi.fn((value: string) => value),
  stripStructuralPrefixes: vi.fn((value: string) => value),
}));

vi.mock("../../channels/plugins/config-writes.js", () => ({
  resolveConfigWriteTargetFromPath: vi.fn(() => "config"),
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeAnyChannelId: vi.fn((value?: string) => value),
  normalizeChannelId: vi.fn((value?: string) => value),
}));

vi.mock("../../config/config-paths.js", () => ({
  getConfigValueAtPath: getConfigValueAtPathMock,
  parseConfigPath: parseConfigPathMock,
  setConfigValueAtPath: setConfigValueAtPathMock,
  unsetConfigValueAtPath: vi.fn(() => true),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../../config/runtime-overrides.js", () => ({
  getConfigOverrides: getConfigOverridesMock,
  resetConfigOverrides: vi.fn(),
  setConfigOverride: vi.fn(() => ({ ok: true })),
  unsetConfigOverride: vi.fn(() => ({ ok: true, removed: true })),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isInternalMessageChannel: isInternalMessageChannelMock,
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => undefined),
}));

vi.mock("./config-commands.js", () => ({
  parseConfigCommand: vi.fn((raw: string) => {
    if (!raw.startsWith("/config")) {
      return null;
    }
    const parts = raw.trim().split(/\s+/);
    const action = parts[1];
    if (action === "show" || action === "get") {
      return { action: "show", path: parts.slice(2).join(" ") || undefined };
    }
    if (action === "set") {
      const assignment = raw.slice(raw.indexOf(" set ") + 5).trim();
      const equalsIndex = assignment.indexOf("=");
      return {
        action: "set",
        path: assignment.slice(0, equalsIndex),
        value: JSON.parse(assignment.slice(equalsIndex + 1)),
      };
    }
    if (action === "unset") {
      return { action: "unset", path: parts.slice(2).join(" ") };
    }
    return { action: "error", message: "Invalid /config syntax." };
  }),
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: resolveConfigWriteDeniedTextMock,
}));

vi.mock("./debug-commands.js", () => ({
  parseDebugCommand: vi.fn((raw: string) => {
    if (!raw.startsWith("/debug")) {
      return null;
    }
    return { action: "show" };
  }),
}));

function buildParams(commandBody: string, cfg: OpenClawConfig): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    SessionKey: "agent:main:main",
  } as MsgContext;

  return {
    ctx,
    cfg,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim(),
      from: "user-1",
      to: "bot-1",
    },
    directives: parseInlineDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("command gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ valid: true, parsed: {} });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      ok: true,
      config: {},
      issues: [],
    });
    getConfigOverridesMock.mockReturnValue({});
    getConfigValueAtPathMock.mockImplementation((target: unknown, path: string[]) => {
      let current = target as Record<string, unknown> | undefined;
      for (const segment of path) {
        if (!current || typeof current !== "object") {
          return undefined;
        }
        current = current[segment] as Record<string, unknown> | undefined;
      }
      return current;
    });
    parseConfigPathMock.mockImplementation((raw: string) => ({
      ok: true,
      path: raw.split("."),
    }));
    setConfigValueAtPathMock.mockImplementation(
      (target: Record<string, unknown>, path: string[], value: unknown) => {
        let cursor: Record<string, unknown> = target;
        for (const segment of path.slice(0, -1)) {
          const next = cursor[segment];
          if (!next || typeof next !== "object") {
            cursor[segment] = {};
          }
          cursor = cursor[segment] as Record<string, unknown>;
        }
        const leaf = path[path.length - 1];
        if (leaf) {
          cursor[leaf] = value;
        }
      },
    );
  });

  it("blocks disabled bash", async () => {
    const result = await handleBashChatCommand({
      ctx: {
        Body: "/bash echo hi",
        CommandBody: "/bash echo hi",
        SessionKey: "agent:main:main",
      } as MsgContext,
      cfg: { commands: { bash: false } } as OpenClawConfig,
      sessionKey: "agent:main:main",
      isGroup: false,
      elevated: { enabled: true, allowed: true, failures: [] },
    });
    expect(result.text).toContain("bash is disabled");
  });

  it("blocks bash when elevated access is unavailable", async () => {
    const result = await handleBashChatCommand({
      ctx: {
        Body: "/bash echo hi",
        CommandBody: "/bash echo hi",
        SessionKey: "agent:main:main",
      } as MsgContext,
      cfg: { commands: { bash: true } } as OpenClawConfig,
      sessionKey: "agent:main:main",
      isGroup: false,
      elevated: {
        enabled: true,
        allowed: false,
        failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
      },
    });
    expect(result.text).toContain("elevated is not available");
  });

  it("blocks disabled config", async () => {
    const params = buildParams("/config show", {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.command.senderIsOwner = true;
    const result = await handleConfigCommand(params, true);
    expect(result?.reply?.text).toContain("/config is disabled");
  });

  it("blocks disabled debug", async () => {
    const params = buildParams("/debug show", {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.command.senderIsOwner = true;
    const result = await handleDebugCommand(params, true);
    expect(result?.reply?.text).toContain("/debug is disabled");
  });

  it("blocks authorized non-owners from /config show and /debug show", async () => {
    const configParams = buildParams("/config show", {
      commands: { config: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult).toEqual({ shouldContinue: false });

    const debugParams = buildParams("/debug show", {
      commands: { debug: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult).toEqual({ shouldContinue: false });
  });

  it("keeps /config show and /debug show available for owners", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const configParams = buildParams("/config show messages.ackReaction", {
      commands: { config: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    configParams.command.senderIsOwner = true;
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult?.reply?.text).toContain("⚙️ Config");
    expect(configResult?.reply?.text).toContain('":)"');

    const debugParams = buildParams("/debug show", {
      commands: { debug: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    debugParams.command.senderIsOwner = true;
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult?.reply?.text).toContain("Debug overrides");
  });

  it("returns explicit unauthorized replies for native privileged commands", async () => {
    const configParams = buildParams("/config show", {
      commands: { config: true, text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    configParams.ctx.CommandSource = "native";
    configParams.command.channel = "telegram";
    configParams.command.channelId = "telegram";
    configParams.command.surface = "telegram";
    const configResult = await handleConfigCommand(configParams, true);
    expect(configResult).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });

    const debugParams = buildParams("/debug show", {
      commands: { debug: true, text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    debugParams.ctx.CommandSource = "native";
    debugParams.command.channel = "telegram";
    debugParams.command.channelId = "telegram";
    debugParams.command.surface = "telegram";
    const debugResult = await handleDebugCommand(debugParams, true);
    expect(debugResult).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
  });

  it("ignores inherited command flags", () => {
    const inheritedCommands = Object.create({
      bash: true,
      config: true,
      debug: true,
    }) as Record<string, unknown>;
    const cfg = { commands: inheritedCommands as never } as OpenClawConfig;
    expect(isCommandFlagEnabled(cfg, "bash")).toBe(false);
    expect(isCommandFlagEnabled(cfg, "config")).toBe(false);
    expect(isCommandFlagEnabled(cfg, "debug")).toBe(false);
  });

  it("blocks disallowed /config set writes", async () => {
    resolveConfigWriteDeniedTextMock
      .mockReturnValueOnce("Config writes are disabled")
      .mockReturnValueOnce("channels.telegram.accounts.work.configWrites=true")
      .mockReturnValueOnce("cannot replace channels, channel roots, or accounts collections");

    const cases = [
      {
        name: "channel config writes disabled",
        params: (() => {
          const params = buildParams('/config set messages.ackReaction=":)"', {
            commands: { config: true, text: true },
            channels: { whatsapp: { allowFrom: ["*"], configWrites: false } },
          } as OpenClawConfig);
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "Config writes are disabled",
      },
      {
        name: "target account disables writes",
        params: (() => {
          const params = buildParams("/config set channels.telegram.accounts.work.enabled=false", {
            commands: { config: true, text: true },
            channels: {
              telegram: {
                configWrites: true,
                accounts: {
                  work: { configWrites: false, enabled: true },
                },
              },
            },
          } as OpenClawConfig);
          params.ctx.Provider = "telegram";
          params.ctx.Surface = "telegram";
          params.command.channel = "telegram";
          params.command.channelId = "telegram";
          params.command.surface = "telegram";
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "channels.telegram.accounts.work.configWrites=true",
      },
      {
        name: "ambiguous channel-root write",
        params: (() => {
          const params = buildParams('/config set channels.telegram={"enabled":false}', {
            commands: { config: true, text: true },
            channels: { telegram: { configWrites: true } },
          } as OpenClawConfig);
          params.ctx.Provider = "telegram";
          params.ctx.Surface = "telegram";
          params.command.channel = "telegram";
          params.command.channelId = "telegram";
          params.command.surface = "telegram";
          params.command.senderIsOwner = true;
          return params;
        })(),
        expectedText: "cannot replace channels, channel roots, or accounts collections",
      },
    ] as const;

    for (const testCase of cases) {
      const previousWriteCount = replaceConfigFileMock.mock.calls.length;
      const result = await handleConfigCommand(testCase.params, true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain(testCase.expectedText);
      expect(replaceConfigFileMock.mock.calls.length).toBe(previousWriteCount);
    }
  });

  it("honors the configured default account when gating omitted-account /config writes", async () => {
    resolveConfigWriteDeniedTextMock.mockReturnValueOnce(
      "channels.telegram.accounts.work.configWrites=true",
    );
    const params = buildParams('/config set messages.ackReaction=":)"', {
      commands: { config: true, text: true },
      channels: {
        telegram: {
          defaultAccount: "work",
          configWrites: true,
          accounts: {
            work: { configWrites: false, enabled: true },
          },
        },
      },
    } as OpenClawConfig);
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";
    params.command.senderIsOwner = true;

    const previousWriteCount = replaceConfigFileMock.mock.calls.length;
    const result = await handleConfigCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(replaceConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("enforces gateway client permissions for /config commands", async () => {
    const baseCfg = { commands: { config: true, text: true } } as OpenClawConfig;

    const blockedParams = buildParams('/config set messages.ackReaction=":)"', baseCfg);
    blockedParams.ctx.Provider = "webchat";
    blockedParams.ctx.Surface = "webchat";
    blockedParams.ctx.GatewayClientScopes = ["operator.write"];
    blockedParams.command.channel = "webchat";
    blockedParams.command.channelId = "webchat";
    blockedParams.command.surface = "webchat";
    blockedParams.command.senderIsOwner = true;
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const blockedResult = await handleConfigCommand(blockedParams, true);
    expect(blockedResult?.shouldContinue).toBe(false);
    expect(blockedResult?.reply?.text).toContain("requires operator.admin");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const showParams = buildParams("/config show messages.ackReaction", baseCfg);
    showParams.ctx.Provider = "webchat";
    showParams.ctx.Surface = "webchat";
    showParams.ctx.GatewayClientScopes = ["operator.write"];
    showParams.command.channel = "webchat";
    showParams.command.channelId = "webchat";
    showParams.command.surface = "webchat";
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const showResult = await handleConfigCommand(showParams, true);
    expect(showResult?.shouldContinue).toBe(false);
    expect(showResult?.reply?.text).toContain("Config messages.ackReaction");

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: { messages: { ackReaction: ":)" } },
    });
    const setParams = buildParams('/config set messages.ackReaction=":D"', baseCfg);
    setParams.ctx.Provider = "webchat";
    setParams.ctx.Surface = "webchat";
    setParams.ctx.GatewayClientScopes = ["operator.write", "operator.admin"];
    setParams.command.channel = "webchat";
    setParams.command.channelId = "webchat";
    setParams.command.surface = "webchat";
    setParams.command.senderIsOwner = true;
    isInternalMessageChannelMock.mockReturnValueOnce(true);
    const setResult = await handleConfigCommand(setParams, true);
    expect(setResult?.shouldContinue).toBe(false);
    expect(setResult?.reply?.text).toContain("Config updated");
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    expect(replaceConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ afterWrite: { mode: "auto" } }),
    );
  });
});
