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
    expect(executePluginCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayClientScopes: ["operator.write", "operator.pairing"],
        sessionKey: "agent:main:whatsapp:direct:test-user",
        sessionId: "session-plugin-command",
        commandBody: "/card",
      }),
    );
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

    expect(executePluginCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
      }),
    );
  });
});
