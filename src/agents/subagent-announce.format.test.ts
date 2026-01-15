import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSpy = vi.fn(async () => ({}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string } };
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "sessions.patch") return {};
    if (typed.method === "sessions.delete") return {};
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  runAgentStep: vi.fn(async () => "did some stuff"),
  readLatestAssistantReply: vi.fn(async () => "raw subagent reply"),
}));

vi.mock("./tools/sessions-announce-target.js", () => ({
  resolveAnnounceTarget: vi.fn(async () => ({
    provider: "telegram",
    to: "+15550001111",
    accountId: "default",
  })),
}));

vi.mock("./tools/sessions-send-helpers.js", () => ({
  isAnnounceSkip: () => false,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(async () => ({ entries: {} })),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { mainKey: "agent:main:main" },
  }),
}));

describe("subagent announce formatting", () => {
  beforeEach(() => {
    sendSpy.mockClear();
  });

  it("wraps unstructured announce into Status/Result/Notes", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-123",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: true,
      startedAt: 10,
      endedAt: 20,
    });

    expect(sendSpy).toHaveBeenCalled();
    const msg = sendSpy.mock.calls[0]?.[0]?.params?.message as string;
    expect(msg).toContain("Status:");
    expect(msg).toContain("Status: error");
    expect(msg).toContain("Result:");
    expect(msg).toContain("Notes:");
    expect(msg).toContain("boom");
  });

  it("keeps runtime status even when announce reply is structured", async () => {
    const agentStep = await import("./tools/agent-step.js");
    vi.mocked(agentStep.runAgentStep).mockResolvedValueOnce(
      "- **Status:** success\n\n- **Result:** did some stuff\n\n- **Notes:** all good",
    );

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: true,
      startedAt: 10,
      endedAt: 20,
    });

    const msg = sendSpy.mock.calls[0]?.[0]?.params?.message as string;
    expect(msg).toContain("Status: error");
    expect(msg).toContain("Result:");
    expect(msg).toContain("Notes:");
  });
});
