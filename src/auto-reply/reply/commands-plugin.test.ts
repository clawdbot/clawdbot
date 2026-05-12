import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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
    const [[commandParams]] = executePluginCommandMock.mock.calls as unknown as Array<
      [
        {
          gatewayClientScopes?: string[];
          sessionKey?: string;
          sessionId?: string;
          commandBody?: string;
        },
      ]
    >;
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
    params.sessionEntry = {
      sessionId: "wrapper-session",
      sessionFile: "/tmp/wrapper-session.jsonl",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    expect(executePluginCommandMock).toHaveBeenCalledTimes(1);
    const [[commandParams]] = executePluginCommandMock.mock.calls as unknown as Array<
      [{ sessionId?: string; sessionFile?: string }]
    >;
    expect(commandParams.sessionId).toBe("target-session");
    expect(commandParams.sessionFile).toBe("/tmp/target-session.jsonl");
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
