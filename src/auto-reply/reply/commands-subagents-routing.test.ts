import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import {
  COMMAND,
  COMMAND_KILL,
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
} from "./commands-subagents-dispatch.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import type { HandleCommandsParams } from "./commands-types.js";

const handleSubagentsSpawnActionMock = vi.hoisted(() =>
  vi.fn(async () => ({ shouldContinue: false, reply: { text: "spawned" } })),
);
const listControlledSubagentRunsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("./commands-subagents/action-spawn.js", () => ({
  handleSubagentsSpawnAction: handleSubagentsSpawnActionMock,
}));

vi.mock("./commands-subagents-control.runtime.js", () => ({
  listControlledSubagentRuns: listControlledSubagentRunsMock,
}));

const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
  const values: string[] = [];
  for (const entry of allowFrom) {
    const value = String(entry).trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
};

let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function registerOwnerEnforcingTelegramPlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: { deliveryMode: "direct" },
          }),
          commands: { enforceOwnerForCommands: true },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            resolveAllowFrom: () => ["*"],
            formatAllowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
}

function buildParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const normalized = commandBody.trim();
  const ctx = {
    Provider: "whatsapp",
    Surface: "whatsapp",
    CommandSource: "text",
    SessionKey: "agent:main:main",
    ...ctxOverrides,
  };
  const surface = ctx.Surface ?? "whatsapp";
  const sessionKey = ctx.SessionKey ?? "agent:main:main";
  const provider = ctx.Provider ?? "whatsapp";

  return {
    cfg: {},
    ctx,
    command: {
      commandBodyNormalized: normalized,
      rawBodyNormalized: normalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: surface,
      channelId: surface,
      surface,
      ownerList: [],
      from: "test-user",
      to: "test-bot",
    },
    directives: {} as HandleCommandsParams["directives"],
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey,
    workspaceDir: "/tmp/openclaw-commands-subagents",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider,
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("subagents command dispatch", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("prefers native command target session keys", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
      SessionKey: "agent:main:slack:slash:u1",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:main");
  });

  it("falls back to the current session for text commands", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "text",
      SessionKey: "agent:main:whatsapp:direct:u1",
      CommandTargetSessionKey: "agent:main:main",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:whatsapp:direct:u1");
  });

  it("maps slash aliases to the right handled prefix", () => {
    expect(resolveHandledPrefix("/subagents list")).toBe(COMMAND);
    expect(resolveHandledPrefix("/kill 1")).toBe(COMMAND_KILL);
    expect(resolveHandledPrefix("/steer 1 continue")).toBeNull();
    expect(resolveHandledPrefix("/unknown")).toBeNull();
  });

  it("maps prefixes and args to subagent actions", () => {
    const listTokens = ["list"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens: listTokens })).toBe("list");
    expect(listTokens).toStrictEqual([]);

    const killTokens = ["1"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND_KILL, restTokens: killTokens })).toBe(
      "kill",
    );
    expect(killTokens).toEqual(["1"]);

    const steerTokens = ["steer", "1", "continue"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens: steerTokens })).toBe(
      "steer",
    );
    expect(steerTokens).toEqual(["1", "continue"]);
  });

  it("returns null for invalid /subagents actions", () => {
    const restTokens = ["foo"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens })).toBeNull();
    expect(restTokens).toEqual(["foo"]);
  });

  it("builds stop replies", () => {
    expect(stopWithText("hello")).toEqual({
      shouldContinue: false,
      reply: { text: "hello" },
    });
  });

  it("rejects native spawn commands from non-owner senders when the plugin enforces owner-only commands", async () => {
    registerOwnerEnforcingTelegramPlugin();
    const cfg = {
      commands: { allowFrom: { "*": ["*"] } },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:999",
      SenderId: "999",
      CommandSource: "native",
      SessionKey: "agent:main:telegram:slash-session",
      CommandTargetSessionKey: "agent:main:telegram:target",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    const params = buildParams(
      "/subagents spawn beta do the thing",
      ctx as unknown as Record<string, unknown>,
    );
    params.cfg = cfg;
    params.command.senderId = auth.senderId;
    params.command.senderIsOwner = auth.senderIsOwner;
    params.command.isAuthorizedSender = auth.isAuthorizedSender;
    params.command.ownerList = auth.ownerList;
    params.command.from = auth.from;
    params.command.to = auth.to;

    const result = await handleSubagentsCommand(params, true);

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
    expect(result).toEqual({ shouldContinue: false });
    expect(listControlledSubagentRunsMock).not.toHaveBeenCalled();
    expect(handleSubagentsSpawnActionMock).not.toHaveBeenCalled();
  });
});
