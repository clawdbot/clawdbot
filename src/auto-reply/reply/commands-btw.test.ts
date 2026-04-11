import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { createMockTypingController } from "./test-helpers.js";

const runBtwSideQuestionMock = vi.fn();
const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: resolveSessionAgentIdMock,
    resolveAgentDir: vi.fn(actual.resolveAgentDir),
  };
});

vi.mock("../../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: unknown[]) => runBtwSideQuestionMock(...args),
}));

const { handleBtwCommand } = await import("./commands-btw.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
  return buildCommandTestParams(commandBody, cfg, undefined, { workspaceDir: "/tmp/workspace" });
}

describe("handleBtwCommand", () => {
  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resolveSessionAgentIdMock.mockReset();
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("returns usage when the side question is missing", async () => {
    const result = await handleBtwCommand(buildParams("/btw"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /btw <side question>" },
    });
  });

  it("ignores /btw when text commands are disabled", async () => {
    const result = await handleBtwCommand(buildParams("/btw what changed?"), false);

    expect(result).toBeNull();
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("ignores /btw from unauthorized senders", async () => {
    const params = buildParams("/btw what changed?");
    params.command.isAuthorizedSender = false;

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("requires an active session context", async () => {
    const params = buildParams("/btw what changed?");
    params.sessionEntry = undefined;

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ /btw requires an active session with existing context." },
    });
  });

  it("still delegates while the session is actively running", async () => {
    const params = buildParams("/btw what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "snapshot answer" });

    const result = await handleBtwCommand(params, true);

    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "what changed?",
        sessionEntry: params.sessionEntry,
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: "off",
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "snapshot answer", btw: { question: "what changed?" } },
    });
  });

  it("starts the typing keepalive while the side question runs", async () => {
    const params = buildParams("/btw what changed?");
    const typing = createMockTypingController();
    params.typing = typing;
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "snapshot answer" });

    await handleBtwCommand(params, true);

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
  });

  it("delegates to the side-question runner", async () => {
    const params = buildParams("/btw what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "nothing important" });

    const result = await handleBtwCommand(params, true);

    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "what changed?",
        agentDir: expect.stringContaining("/agents/main/agent"),
        sessionEntry: params.sessionEntry,
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: "off",
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "nothing important", btw: { question: "what changed?" } },
    });
  });

  it("falls back to the resolved agent dir when the caller omits it", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "worker-1";
    params.agentDir = undefined;
    delete (params as { sessionKey?: string }).sessionKey;
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.stringContaining("/agents/worker-1/agent"),
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "resolved fallback", btw: { question: "what changed?" } },
    });
  });

  it("uses the canonical session agent when resolving a fallback agent dir", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "main";
    params.agentDir = undefined;
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    resolveSessionAgentIdMock.mockReturnValue("worker-1");
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "agent:worker-1:whatsapp:direct:12345",
      config: expect.any(Object),
    });
    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.stringContaining("/agents/worker-1/agent"),
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "resolved fallback", btw: { question: "what changed?" } },
    });
  });

  it("uses the canonical session agent dir even when the wrapper agentDir disagrees", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "main";
    params.agentDir = "/tmp/main-agent";
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    resolveSessionAgentIdMock.mockReturnValue("worker-1");
    vi.mocked(resolveAgentDir).mockReturnValue("/tmp/worker-1-agent");
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "agent:worker-1:whatsapp:direct:12345",
      config: expect.any(Object),
    });
    expect(vi.mocked(resolveAgentDir)).toHaveBeenCalledWith(expect.any(Object), "worker-1");
    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/worker-1-agent",
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "resolved fallback", btw: { question: "what changed?" } },
    });
  });

  it("prefers the target session entry for side-question context", async () => {
    const params = buildParams("/btw what changed?");
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
    };
    params.sessionStore = {
      "agent:worker-1:whatsapp:direct:12345": {
        sessionId: "target-session",
        updatedAt: Date.now(),
      },
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "target context" });

    const result = await handleBtwCommand(params, true);

    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          sessionId: "target-session",
        }),
      }),
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "target context", btw: { question: "what changed?" } },
    });
  });
});
