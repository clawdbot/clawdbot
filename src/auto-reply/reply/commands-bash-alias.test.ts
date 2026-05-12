import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleBashCommand } from "./commands-bash.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const handleBashChatCommandMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "No active bash job" })),
);

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("./bash-command.js", () => ({
  handleBashChatCommand: handleBashChatCommandMock,
}));

function buildBashParams(commandBodyNormalized: string): HandleCommandsParams {
  return {
    cfg: {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "test-user",
      to: "test-bot",
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    elevated: { enabled: true, allowed: true, failures: [] },
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("handleBashCommand alias routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
  });

  it("routes !poll and !stop through the bash chat handler", async () => {
    for (const aliasCommand of ["!poll", "!stop"]) {
      const result = await handleBashCommand(buildBashParams(aliasCommand), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("No active bash job");
    }
    expect(handleBashChatCommandMock).toHaveBeenCalledTimes(2);
  });

  it("uses the canonical target session agent for /bash routing", async () => {
    const params = buildBashParams("/bash pwd");
    params.agentId = "main";
    params.sessionKey = "agent:target:whatsapp:direct:test-user";

    const result = await handleBashCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(handleBashChatCommandMock).toHaveBeenCalledTimes(1);
    const [[bashParams]] = handleBashChatCommandMock.mock.calls as unknown as Array<
      [{ agentId?: string; sessionKey?: string }]
    >;
    expect(bashParams.agentId).toBe("target");
    expect(bashParams.sessionKey).toBe("agent:target:whatsapp:direct:test-user");
  });
});
