// Tests background side-question command routing and typing controller integration.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { resolveAgentDirMock } from "./commands-agent-scope.test-support.js";
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

describe("handleBtwCommand", () => {
  beforeEach(() => {
    runBtwSideQuestionMock.mockReset();
    resolveAgentDirMock.mockReset();
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
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

  it("returns an actionable visible error before running a restricted side question", async () => {
    const params = buildParams("/btw what changed?");
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
    params.ctx.ConversationToolPolicy = { deny: ["exec"] };

    const result = await handleBtwCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw cannot enforce this conversation's tool policy. Ask in the main conversation or switch this session to the embedded runtime.",
        btw: { question: "what changed?" },
        isError: true,
      },
    });
    expect(runBtwSideQuestionMock).not.toHaveBeenCalled();
  });

  it("delegates to the side-question runner", async () => {
    const params = buildParams("/btw what changed?");
    const typing = createMockTypingController();
    params.typing = typing;
    params.command.senderId = "sender-1";
    params.command.senderIsOwner = true;
    params.ctx.AccountId = "account-1";
    params.ctx.RuntimePolicySessionKey = "agent:main:runtime-policy";
    params.ctx.GroupChannel = "#ops";
    params.ctx.GroupSpace = "workspace-1";
    params.ctx.SenderId = "sender-1";
    params.ctx.SenderName = "Rosita";
    params.ctx.SenderUsername = "rosita";
    params.ctx.SenderE164 = "+15550001";
    params.ctx.MessageThreadId = "thread-1";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      groupId: "group-1",
      parentSessionKey: "agent:main:parent",
      updatedAt: Date.now(),
    };
    let resolvedTurnContext: ReturnType<typeof resolveMessageActionTurnCapability> | undefined;
    runBtwSideQuestionMock.mockImplementation(async (input: Record<string, unknown>) => {
      resolvedTurnContext = resolveMessageActionTurnCapability({
        token:
          typeof input.messageActionTurnCapability === "string"
            ? input.messageActionTurnCapability
            : undefined,
        agentId: "main",
        runId: typeof input.authorityRunId === "string" ? input.authorityRunId : undefined,
        sessionKey: "agent:main:runtime-policy",
        sessionId: "session-1",
      });
      return { text: "nothing important" };
    });

    const result = await handleBtwCommand(params, true);

    const runnerArgs = mockFirstObjectArg(runBtwSideQuestionMock);
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expectObjectFields(runnerArgs, {
      question: "what changed?",
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      messageChannel: "whatsapp",
      messageProvider: "whatsapp",
      agentAccountId: "account-1",
      sandboxSessionKey: "agent:main:runtime-policy",
      messageThreadId: "thread-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
      senderIsOwner: true,
    });
    expect(runnerArgs.agentDir).toBe(params.agentDir);
    expect(runnerArgs.messageActionTurnCapability).toEqual(expect.any(String));
    expect(runnerArgs.opts).toMatchObject({ runId: expect.any(String) });
    expect(runnerArgs.authorityRunId).toEqual(expect.any(String));
    expect(runnerArgs.authorityRunId).not.toBe(
      (runnerArgs.opts as { runId?: string } | undefined)?.runId,
    );
    expect(resolvedTurnContext).toMatchObject({
      requesterAccountId: "account-1",
      requesterSenderId: "sender-1",
      toolContext: {
        currentChannelProvider: "whatsapp",
      },
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "nothing important", btw: { question: "what changed?" } },
    });
  });

  it("uses the originating target before the command transport target", async () => {
    const params = buildParams("/btw what changed?");
    params.ctx.OriginatingTo = "channel:source";
    params.ctx.NativeChannelId = "native:source";
    params.ctx.ChatType = "channel";
    params.command.to = "slash:transport";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "source target" });

    await handleBtwCommand(params, true);

    expectObjectFields(mockFirstObjectArg(runBtwSideQuestionMock), {
      chatId: "native:source",
      chatType: "channel",
      messageTo: "channel:source",
      currentChannelId: "native:source",
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

  it("does not mint current-turn context for Gateway chat with an explicit origin", async () => {
    const params = buildParams("/btw what changed?");
    params.ctx.Provider = "webchat";
    params.ctx.OriginatingChannel = "matrix";
    params.ctx.OriginatingTo = "!room:example.org";
    params.command.channel = "matrix";
    params.command.to = "!room:example.org";
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "origin answer" });

    await handleBtwCommand(params, true);

    expect(mockFirstObjectArg(runBtwSideQuestionMock).messageActionTurnCapability).toBeUndefined();
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

  it("uses the canonical session agent when resolving a fallback agent dir", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "worker-1";
    params.agentDir = undefined;
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
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

  it("reuses the prepared session agent directory", async () => {
    const params = buildParams("/btw what changed?");
    params.agentId = "worker-1";
    params.agentDir = "/tmp/worker-1-agent";
    params.sessionKey = "agent:worker-1:whatsapp:direct:12345";
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    runBtwSideQuestionMock.mockResolvedValue({ text: "resolved fallback" });

    const result = await handleBtwCommand(params, true);

    expect(resolveAgentDirMock).not.toHaveBeenCalled();
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
