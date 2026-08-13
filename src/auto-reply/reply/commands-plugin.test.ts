// Tests plugin command dispatch and plugin-scoped command aliases.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandExecutionReplyOptions,
} from "../../plugins/plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { shouldBypassPluginOwnedBindingForCommand } from "./dispatch-from-config.plugin-binding.js";

let registry: PluginRegistry;

function registerTestCommand(
  result: PluginCommandResult = { text: "from plugin" },
  overrides: Partial<Parameters<typeof registerPluginCommandInRegistry>[2]> = {},
) {
  const handler = vi.fn(async (_ctx: PluginCommandContext) => result);
  expect(
    registerPluginCommandInRegistry(registry, "test-plugin", {
      name: "card",
      description: "Card command",
      handler,
      ...overrides,
    }),
  ).toEqual({ ok: true });
  return handler;
}

function firstCommandContext(handler: ReturnType<typeof registerTestCommand>) {
  return expectDefined(handler.mock.calls[0]?.[0], "plugin command handler context");
}

function buildPluginParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      GatewayClientScopes: ["operator.write", "operator.pairing"],
      AccountId: undefined,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      from: "test-user",
      to: "test-bot",
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
  } as unknown as HandleCommandsParams;
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("dispatches registered plugin commands with gateway scopes and session metadata", async () => {
    const handler = registerTestCommand();

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("from plugin");
    expect(handler).toHaveBeenCalledTimes(1);
    const commandParams = firstCommandContext(handler);
    expect(commandParams.gatewayClientScopes).toEqual(["operator.write", "operator.pairing"]);
    expect(commandParams.sessionKey).toBe("agent:main:whatsapp:direct:test-user");
    expect(commandParams.sessionId).toBe("session-plugin-command");
    expect(commandParams.commandBody).toBe("/card");
  });

  it("prefers the target session entry from sessionStore for plugin command metadata", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.agentId = "requester";
    params.sessionKey = "agent:target:whatsapp:direct:test-user";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      sessionFile: "/tmp/wrapper-session.jsonl",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
        authProfileOverride: "openai:owner@example.com",
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    expect(handler).toHaveBeenCalledTimes(1);
    const commandParams = firstCommandContext(handler);
    expect(commandParams.agentId).toBe("target");
    expect(commandParams.sessionId).toBe("target-session");
    expect(commandParams.sessionTarget).toMatchObject({
      agentId: "target",
      sessionId: "target-session",
      sessionKey: params.sessionKey,
    });
    expect(parseSqliteSessionFileMarker(commandParams.sessionFile)).toMatchObject({
      agentId: "target",
      sessionId: "target-session",
    });
  });

  it("uses the process-local transcript store for incognito plugin commands", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: "/tmp/durable/{agentId}/sessions.json" },
    } as OpenClawConfig);
    params.agentId = "main";
    params.sessionKey = "agent:main:dashboard:incognito-plugin-command";
    params.storePath = "/tmp/durable/main/sessions.json";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "incognito-session",
        incognito: true,
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    const commandParams = firstCommandContext(handler);
    const expectedStorePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(commandParams.sessionTarget?.storePath).toBe(expectedStorePath);
    expect(parseSqliteSessionFileMarker(commandParams.sessionFile)?.storePath).toBe(
      expectedStorePath,
    );
  });

  it("keeps the current agent for unqualified global session keys", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: "/tmp/durable/{agentId}/sessions.json" },
    } as OpenClawConfig);
    params.agentId = "other";
    params.sessionKey = "global";

    await handlePluginCommand(params, true);

    const commandParams = firstCommandContext(handler);
    expect(commandParams.sessionTarget).toMatchObject({
      agentId: "other",
      storePath: "/tmp/durable/other/sessions.json",
    });
  });

  it("continues the agent without leaking continueAgent into the reply payload", async () => {
    registerTestCommand({
      text: "from plugin",
      continueAgent: true,
    });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toEqual({
      shouldContinue: true,
      reply: { text: "from plugin" },
    });
  });

  it("enforces requiredScopes through the command handler path", async () => {
    const handler = vi.fn().mockResolvedValue({
      text: "approved",
      continueAgent: true,
    });
    expect(
      registerPluginCommandInRegistry(registry, "approval-plugin", {
        name: "approve-deploy",
        description: "Approve deployment",
        requiredScopes: ["operator.approvals"],
        handler,
      }),
    ).toEqual({ ok: true });

    const denied = await handlePluginCommand(
      buildPluginParams("/approve-deploy", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(denied).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ This command requires gateway scope: operator.approvals." },
    });
    expect(handler).not.toHaveBeenCalled();

    const allowedParams = buildPluginParams("/approve-deploy", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    allowedParams.ctx.GatewayClientScopes = ["operator.approvals"];

    const allowed = await handlePluginCommand(allowedParams, true);

    expect(allowed).toEqual({
      shouldContinue: true,
      reply: { text: "approved" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("carries one binding selection into dispatch without rematching a replacement registry", async () => {
    const originalHandler = registerTestCommand();
    const replyOptions: NonNullable<HandleCommandsParams["opts"]> &
      PluginCommandExecutionReplyOptions = {};
    const cfg = { commands: { text: true } } as OpenClawConfig;
    expect(
      shouldBypassPluginOwnedBindingForCommand(
        {
          Body: "/card",
          CommandAuthorized: true,
          CommandSource: "text",
          Provider: "whatsapp",
          Surface: "whatsapp",
        } as never,
        cfg,
        replyOptions,
      ),
    ).toBe(true);
    expect(replyOptions[PLUGIN_COMMAND_DISPATCH]?.kind).toBe("plugin");

    const replacement = createEmptyPluginRegistry();
    const replacementHandler = vi.fn(async () => ({ text: "replacement" }));
    expect(
      registerPluginCommandInRegistry(replacement, "replacement", {
        name: "card",
        description: "Replacement card",
        handler: replacementHandler,
      }),
    ).toEqual({ ok: true });
    setActivePluginRegistry(replacement);
    const params = buildPluginParams("/card", cfg);
    params.opts = replyOptions;

    const result = await handlePluginCommand(params, true);

    expect(result?.reply?.text).toContain("registry changed");
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it("treats an explicit non-plugin catalog winner as terminal for plugin matching", async () => {
    const handler = registerTestCommand();
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    params.opts = {
      [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
    } as NonNullable<HandleCommandsParams["opts"]> & PluginCommandExecutionReplyOptions;

    await expect(handlePluginCommand(params, true)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});
