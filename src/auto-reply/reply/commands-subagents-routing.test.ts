// Tests subagent inspection command routing and authorization.
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
import { handleAcpCommand } from "./commands-acp.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { resolveRequesterSessionKey } from "./commands-subagents/shared.js";
import type { HandleCommandsParams } from "./commands-types.js";

const listControlledSubagentRunsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("../../agents/subagents/registry/subagent-control-scope.js", () => ({
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

  it.each([
    "/focus target",
    "/unfocus",
    "/subagentsXYZ",
    "/agentsXYZ",
    "/kill 1",
    "/steer hi",
    "/unknown",
  ])("does not dispatch unrelated command %s", async (command) => {
    expect(await handleSubagentsCommand(buildParams(command), true)).toBeNull();
    expect(listControlledSubagentRunsMock).not.toHaveBeenCalled();
  });

  it.each(["help", "foo", "steer 1 continue", "agents"])(
    "shows %s help without reading session state",
    async (action) => {
      const params = buildParams(`/subagents ${action}`, { SessionKey: "" });
      const result = await handleSubagentsCommand(params, true);
      expect(result?.reply?.text).toContain("/subagents list");
      expect(result?.reply?.text).toContain("/session unbind");
      expect(listControlledSubagentRunsMock).not.toHaveBeenCalled();
    },
  );

  it.each(["/acpXYZ", "/acp@otherbot help"])(
    "does not dispatch ACP lookalike %s",
    async (command) => {
      expect(await handleAcpCommand(buildParams(command), true)).toBeNull();
    },
  );

  it("rejects native subagents commands from non-owner senders when the plugin enforces owner-only commands", async () => {
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
    const params = buildParams("/subagents list", ctx as unknown as Record<string, unknown>);
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
  });
});
