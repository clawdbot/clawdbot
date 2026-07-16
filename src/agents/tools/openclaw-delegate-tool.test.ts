import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createOpenClawDelegateToolsForRun } from "./openclaw-delegate-tool.js";

vi.mock("./in-process-gateway.js", () => ({
  callInProcessGatewayTool: vi.fn(),
}));

const callGateway = vi.mocked(callInProcessGatewayTool);

beforeEach(() => {
  callGateway.mockReset();
});

describe("openclaw delegation tool", () => {
  it("relays context and surfaces pending approval", async () => {
    callGateway.mockResolvedValue({
      sessionId: "ignored-by-client",
      reply: "Approval pending.",
      action: "none",
      needsApproval: true,
      proposalId: "system-agent:proposal-1",
    });
    const tool = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:dm:one",
      agentChannel: "webchat",
    })[0];
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }

    const result = await tool.execute("call-1", { message: "Add channel." });

    expect(callGateway).toHaveBeenCalledWith("openclaw.chat", {
      sessionId: expect.stringMatching(/^delegate-[a-f0-9]{32}$/),
      message: "Add channel.",
      delegation: {
        agentId: "main",
        sessionKey: "agent:main:dm:one",
        turnSourceChannel: "webchat",
      },
    });
    expect(result.details).toEqual({
      reply: "Approval pending.",
      needsApproval: true,
      proposalId: "system-agent:proposal-1",
    });
    expect(tool.catalogMode).toBeUndefined();
  });

  it("reuses one session and accepts explicit continuation", async () => {
    callGateway.mockImplementation(async (_method: string, params: Record<string, unknown>) => ({
      sessionId: params.sessionId,
      reply: "Done.",
    }));
    const tool = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:main",
    })[0];
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }

    await tool.execute("call-1", { message: "First." });
    await tool.execute("call-2", { message: "Second." });
    await tool.execute("call-3", { message: "Other.", sessionId: "delegate-user-choice" });

    expect(callGateway.mock.calls[0]?.[1]).toMatchObject({
      sessionId: callGateway.mock.calls[1]?.[1].sessionId,
    });
    expect(callGateway.mock.calls[2]?.[1]).toMatchObject({ sessionId: "delegate-user-choice" });
  });

  it("uses the owner-only core gate", () => {
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("openclaw");
  });
});
