/** Tests bash command aliases and chat shortcut handling. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleBashCommand } from "./commands-bash.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const handleBashChatCommandMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "No active bash job" })),
);

vi.mock("./bash-command.js", () => ({
  handleBashChatCommand: handleBashChatCommandMock,
}));

function buildBashParams(commandBody: string) {
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { bash: true, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    },
    { SenderId: "owner", From: "test-user", To: "test-bot" },
  );
  params.sessionKey = "agent:main:whatsapp:direct:test-user";
  params.command.senderIsOwner = true;
  return params;
}

describe("handleBashCommand alias routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    params.agentId = "target";
    params.sessionKey = "agent:target:whatsapp:direct:test-user";

    const result = await handleBashCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(handleBashChatCommandMock).toHaveBeenCalledTimes(1);
    expect(handleBashChatCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "target",
        sessionKey: "agent:target:whatsapp:direct:test-user",
      }),
    );
  });
});
