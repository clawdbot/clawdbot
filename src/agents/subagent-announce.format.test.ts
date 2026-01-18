import { beforeEach, describe, expect, it, vi } from "vitest";

const agentSpy = vi.fn(async () => ({ runId: "run-main", status: "ok" }));
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
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
  readLatestAssistantReply: vi.fn(async () => "raw subagent reply"),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("subagent announce formatting", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("sends instructional message to main agent with status and findings", async () => {
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

    expect(agentSpy).toHaveBeenCalled();
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: { message?: string; sessionKey?: string };
    };
    const msg = call?.params?.message as string;
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(msg).toContain("background task");
    expect(msg).toContain("failed");
    expect(msg).toContain("boom");
    expect(msg).toContain("Findings:");
    expect(msg).toContain("raw subagent reply");
    expect(msg).toContain("Stats:");
  });

  it("includes success status when outcome is ok", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    // Use waitForCompletion: false so it uses the provided outcome instead of calling agent.wait
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("completed successfully");
  });

  it("steers announcements into an active run when queue mode is steer", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(true);
    embeddedRunMock.queueEmbeddedPiMessage.mockReturnValue(true);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "steer",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-789",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-123",
      expect.stringContaining("background task"),
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("queues announce delivery with origin account routing", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-456",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-999",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.to).toBe("+1555");
    expect(call?.params?.accountId).toBe("kev");
  });

  it("splits collect-mode queues when accountId differs", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-acc-split",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 80,
      },
    };

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-a",
        childRunId: "run-a",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-a" },
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
    ]);

    await new Promise((r) => setTimeout(r, 120));
    expect(agentSpy).toHaveBeenCalledTimes(2);
    const accountIds = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { accountId?: string } })?.params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it("uses requester origin for direct announce when not queued", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123" },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.accountId).toBe("acct-123");
  });

  it("normalizes requesterOrigin for direct announce delivery", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-origin",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 " },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.accountId).toBe("acct-987");
  });

  it("splits collect-mode announces when accountId differs", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-789",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-a",
      requesterSessionKey: "main",
      requesterOrigin: { accountId: "acct-a" },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-b",
      requesterSessionKey: "main",
      requesterOrigin: { accountId: "acct-b" },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    await new Promise((r) => setTimeout(r, 5));

    const accountIds = agentSpy.mock.calls.map(
      (call) => (call[0] as { params?: Record<string, unknown> }).params?.accountId,
    );
    expect(accountIds).toContain("acct-a");
    expect(accountIds).toContain("acct-b");
    expect(agentSpy).toHaveBeenCalledTimes(2);
  });
});
