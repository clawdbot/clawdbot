// Tests plugin command dispatch and plugin-scoped command aliases.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";

const matchPluginCommandMock = vi.hoisted(() => vi.fn());
const executePluginCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/commands.js", () => ({
  matchPluginCommand: matchPluginCommandMock,
  executePluginCommand: executePluginCommandMock,
}));

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
    vi.clearAllMocks();
  });

  it("dispatches registered plugin commands with gateway scopes and session metadata", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("from plugin");
    expect(executePluginCommandMock).toHaveBeenCalledTimes(1);
    const [commandParams] = expectDefined(
      (
        executePluginCommandMock.mock.calls as unknown as Array<
          [
            {
              gatewayClientScopes?: string[];
              sessionKey?: string;
              sessionId?: string;
              commandBody?: string;
            },
          ]
        >
      )[0],
      "(executePluginCommandMock.mock.calls as unknown as Array<\n        [\n          {\n            gatewayClientScopes?: string[];\n            sessionKey?: string;\n            sessionId?: string;\n            commandBody?: string;\n          },\n        ]\n      >)[0] test invariant",
    );
    expect(commandParams.gatewayClientScopes).toEqual(["operator.write", "operator.pairing"]);
    expect(commandParams.sessionKey).toBe("agent:main:whatsapp:direct:test-user");
    expect(commandParams.sessionId).toBe("session-plugin-command");
    expect(commandParams.commandBody).toBe("/card");
  });

  it("prefers the target session entry from sessionStore for plugin command metadata", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

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

    expect(executePluginCommandMock).toHaveBeenCalledTimes(1);
    const [commandParams] = expectDefined(
      (
        executePluginCommandMock.mock.calls as unknown as Array<
          [
            {
              agentId?: string;
              authProfileId?: string;
              sessionId?: string;
              sessionFile?: string;
              sessionTarget?: { agentId?: string; sessionId?: string; sessionKey?: string };
            },
          ]
        >
      )[0],
      "(executePluginCommandMock.mock.calls as unknown as Array<\n        [{ authProfileId?: string; sessionId?: string; sessionFile?: string }]\n      >)[0] test invariant",
    );
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
    expect(commandParams.authProfileId).toBe("openai:owner@example.com");
  });

  it("uses the process-local transcript store for incognito plugin commands", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

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

    const [commandParams] = expectDefined(
      executePluginCommandMock.mock.calls[0] as unknown as [
        { sessionFile?: string; sessionTarget?: { storePath?: string } },
      ],
      "plugin command invocation",
    );
    const expectedStorePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(commandParams.sessionTarget?.storePath).toBe(expectedStorePath);
    expect(parseSqliteSessionFileMarker(commandParams.sessionFile)?.storePath).toBe(
      expectedStorePath,
    );
  });

  it("keeps the current agent for unqualified global session keys", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: "/tmp/durable/{agentId}/sessions.json" },
    } as OpenClawConfig);
    params.agentId = "other";
    params.sessionKey = "global";

    await handlePluginCommand(params, true);

    const [commandParams] = expectDefined(
      executePluginCommandMock.mock.calls[0] as unknown as [
        { sessionTarget?: { agentId?: string; storePath?: string } },
      ],
      "plugin command invocation",
    );
    expect(commandParams.sessionTarget).toMatchObject({
      agentId: "other",
      storePath: "/tmp/durable/other/sessions.json",
    });
  });

  it("continues the agent without leaking continueAgent into the reply payload", async () => {
    matchPluginCommandMock.mockReturnValue({
      command: { name: "card" },
      args: "",
    });
    executePluginCommandMock.mockResolvedValue({
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
    const actualCommands = await vi.importActual<typeof import("../../plugins/commands.js")>(
      "../../plugins/commands.js",
    );
    const handler = vi.fn().mockResolvedValue({
      text: "approved",
      continueAgent: true,
    });
    const command = {
      pluginId: "approval-plugin",
      pluginName: "Approval Plugin",
      pluginRoot: "/tmp/approval-plugin",
      name: "approve-deploy",
      description: "Approve deployment",
      requiredScopes: ["operator.approvals"],
      handler,
    };
    matchPluginCommandMock.mockReturnValue({
      command,
      args: "",
    });
    executePluginCommandMock.mockImplementation(actualCommands.executePluginCommand);

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
});
