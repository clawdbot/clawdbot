import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { createMockTypingController } from "./test-helpers.js";

const runBtwSideQuestionMock = vi.fn();

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

function mockCall(mock: unknown, index = 0): Array<unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index + 1}`);
  }
  return call;
}

function mockFirstObjectArg(mock: unknown): Record<string, unknown> {
  const [arg] = mockCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first mock argument object");
  }
  return arg as Record<string, unknown>;
}

function expectObjectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected object fields");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("handleBtwCommand", () => {
  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resolveAgentDirMock.mockReset();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReset();
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("returns usage when the side question is missing", async () => {
    const result = await handleBtwCommand(buildParams("/btw"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /btw [side question]" },
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

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      question: "what changed?",
      sessionEntry: params.sessionEntry,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
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

    const runnerArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expectObjectFields(runnerArgs, {
      question: "what changed?",
      sessionEntry: params.sessionEntry,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      messageChannel: "whatsapp",
      messageProvider: "whatsapp",
    });
    expect(String(runnerArgs.agentDir)).toContain("/agents/main/agent");
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "nothing important", btw: { question: "what changed?" } },
    });
  });

  it("uses the originating target before the command transport target", async () => {
    const params = buildParams("/btw what changed?");
    params.ctx.OriginatingTo = "channel:source";
    params.command.to = "slash:transport";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "source target" });

    await handleBtwCommand(params, true);

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      currentChannelId: "channel:source",
    });
  });

  it("keeps provider and conversation target separate for side-question approvals", async () => {
    const params = buildParams("/btw what changed?");
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.to = "+2000";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "targeted answer" });

    await handleBtwCommand(params, true);

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "+2000",
    });
  });

  it("accepts /side as a /btw alias", async () => {
    const params = buildParams("/side what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "alias answer" });

    const result = await handleBtwCommand(params, true);

    expect(mockFirstObjectArg(runBtwSideQuestionMock).question).toBe("what changed?");
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "alias answer", btw: { question: "what changed?" } },
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

    expect(String(mockFirstObjectArg(runBtwSideQuestionMock).agentDir)).toContain(
      "/agents/worker-1/agent",
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

    const sessionAgentArgs = mockFirstObjectArg(resolveSessionAgentIdMock);
    expect(sessionAgentArgs.sessionKey).toBe("agent:worker-1:whatsapp:direct:12345");
    if (!sessionAgentArgs.config || typeof sessionAgentArgs.config !== "object") {
      throw new Error("expected session agent config");
    }
    expect(String(mockFirstObjectArg(runBtwSideQuestionMock).agentDir)).toContain(
      "/agents/worker-1/agent",
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
    resolveAgentDirMock.mockReturnValue("/tmp/worker-1-agent");
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    const canonicalAgentArgs = mockFirstObjectArg(resolveSessionAgentIdMock);
    expect(canonicalAgentArgs.sessionKey).toBe("agent:worker-1:whatsapp:direct:12345");
    if (!canonicalAgentArgs.config || typeof canonicalAgentArgs.config !== "object") {
      throw new Error("expected canonical agent config");
    }
    const resolveDirCall = mockCall(resolveAgentDirMock);
    if (!resolveDirCall[0] || typeof resolveDirCall[0] !== "object") {
      throw new Error("expected resolveAgentDir config");
    }
    expect(resolveDirCall[1]).toBe("worker-1");
    expect(mockFirstObjectArg(runBtwSideQuestionMock).agentDir).toBe("/tmp/worker-1-agent");
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

    const sideQuestionArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expectObjectFields(sideQuestionArgs.sessionEntry, { sessionId: "target-session" });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "target context", btw: { question: "what changed?" } },
    });
  });
});
