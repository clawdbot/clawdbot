import { describe, expect, it, vi } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import {
  buildTranscriptReplyText,
  createChatSendReplyDispatch,
} from "./chat-send-reply-dispatch.js";

describe("buildTranscriptReplyText", () => {
  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "keeps %s out of combined command display text",
    async (controlText) => {
      const payloads = [{ text: "First instruction" }, { text: controlText }, { text: "Done" }];
      expect(buildTranscriptReplyText(payloads)).toBe("First instruction\n\nDone");
      expect(
        (
          await buildAssistantReplyContent({
            sessionKey: "agent:main:main",
            agentId: "main",
            payloads,
          })
        ).assistantContent,
      ).toEqual([{ type: "text", text: "First instruction\n\nDone" }]);
    },
  );

  it("preserves authored indentation across split fenced-code reply payloads", () => {
    expect(
      buildTranscriptReplyText([
        { text: "Here is the YAML:\n\n```yaml\nroot:\n" },
        { text: "  nested:\n    value: true\n```" },
      ]),
    ).toBe("Here is the YAML:\n\n```yaml\nroot:\n  nested:\n    value: true\n```");
  });

  it("preserves authored CRLF boundaries and skips whitespace-only reply payloads", () => {
    expect(
      buildTranscriptReplyText([
        { text: "```yaml\r\nroot:\r\n" },
        { text: "  \t\n" },
        { text: "  nested: true\r\n```" },
      ]),
    ).toBe("```yaml\r\nroot:\r\n  nested: true\r\n```");
  });

  it("keeps reply directives and safe media while suppressing reasoning", () => {
    expect(
      buildTranscriptReplyText([
        { text: "hidden", isReasoning: true },
        {
          text: "Hello",
          replyToId: "message-1",
          mediaUrls: ["https://example.test/photo.png"],
        },
        {
          text: "Listen",
          audioAsVoice: true,
          mediaUrl: "https://example.test/clip.mp3",
        },
        {
          text: "private",
          sensitiveMedia: true,
          mediaUrl: "https://example.test/private.png",
        },
      ]),
    ).toBe(
      [
        "[[reply_to:message-1]]\nHello\nAttachment: https://example.test/photo.png",
        "Listen\nAttachment: https://example.test/clip.mp3\n[[audio_as_voice]]",
        "private",
      ].join("\n\n"),
    );
  });
});

describe("createChatSendReplyDispatch", () => {
  it("owns assistant media before transcript publication only during its live dispatch", async () => {
    let current = true;
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      isRunCurrent: () => current,
      logGateway: { warn: vi.fn() } as never,
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-media",
        sessionKey: "agent:main:main",
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked: vi.fn() },
    });
    const rawText =
      "[[reply_to_current]] Artifacts ready\nMEDIA:./artifact.json\n```text\nMEDIA:./example.png\n```";
    const prepare = () =>
      runAgentHarnessBeforeMessageWriteHook({
        message: buildAssistantMessage({
          model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
          content: [{ type: "text", text: rawText }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
        prepareAssistantTranscriptMessage: dispatch.prepareAssistantTranscriptMessage,
      });
    expect(projectChatDisplayMessage(prepare())).toMatchObject({
      content: [{ type: "text", text: rawText }],
    });
    await dispatch.runAgentMediaTranscript({ run: async (operation) => operation() }, async () => {
      const persisted = prepare();
      expect(persisted).toMatchObject({
        content: [{ type: "text", text: rawText }],
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      expect(projectChatDisplayMessage(persisted)).toMatchObject({
        content: [
          {
            type: "text",
            text: "[[reply_to_current]] Artifacts ready\n```text\nMEDIA:./example.png\n```",
          },
        ],
      });
      current = false;
      expect(prepare()).not.toHaveProperty("openclawDelivery");
      current = true;
    });
    expect(prepare()).not.toHaveProperty("openclawDelivery");
  });

  it("captures visible replies, promotes tool media, and marks blocked turns", async () => {
    const markBlocked = vi.fn();
    const onCommandBlock = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => false,
      isRunCurrent: () => true,
      onCommandBlock,
      logGateway: { warn: vi.fn() } as never,
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked },
    });
    expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
    const blockedPayload = setReplyPayloadMetadata(
      { text: "blocked" },
      { beforeAgentRunBlocked: true },
    );

    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendBlockReply(blockedPayload);
    dispatcher.sendToolResult({
      text: "tool summary",
      mediaUrl: "https://example.test/audio.mp3",
    });
    dispatcher.sendFinalReply({ text: "done" });
    await dispatcher.waitForIdle();

    expect(onCommandBlock).toHaveBeenCalledExactlyOnceWith("blocked");
    dispatcher.markComplete();
    expect(markBlocked).toHaveBeenCalledOnce();
    expect(dispatch.deliveredReplies).toEqual([
      { payload: blockedPayload, kind: "block" },
      {
        payload: {
          text: undefined,
          mediaUrl: "https://example.test/audio.mp3",
        },
        kind: "final",
      },
      { payload: { text: "done" }, kind: "final" },
    ]);
  });

  it("publishes ordered command text while pending and suppresses hidden or retired output", async () => {
    let current = true;
    let agentRunStarted = false;
    const onCommandBlock = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => agentRunStarted,
      isRunCurrent: () => current,
      onCommandBlock,
      logGateway: { warn: vi.fn() } as never,
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-command",
        sessionKey: "agent:main:main",
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked: vi.fn() },
    });
    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendBlockReply({ text: "[[reply_to_current]] First instruction" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).toHaveBeenLastCalledWith("First instruction");
    dispatcher.sendBlockReply({ text: "Second instruction" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).toHaveBeenLastCalledWith("First instruction\n\nSecond instruction");

    onCommandBlock.mockClear();
    dispatcher.sendBlockReply({ text: "hidden reasoning", isReasoning: true });
    dispatcher.sendBlockReply({ text: "NO_REPLY" });
    dispatcher.sendBlockReply({ text: "ANNOUNCE_SKIP" });
    dispatcher.sendBlockReply({ text: "side answer", btw: { question: "side question" } });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();

    current = false;
    dispatcher.sendBlockReply({ text: "retired command" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();

    current = true;
    agentRunStarted = true;
    dispatcher.sendBlockReply({ text: "native agent stream" });
    dispatcher.sendFinalReply({ text: "native final" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();
  });

  it("keeps every capture and media side effect behind beforeDeliver cancellation", async () => {
    const markBlocked = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      logGateway: { warn: vi.fn() } as never,
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-cancel",
        sessionKey: "agent:main:main",
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked },
    });
    const dispatcher = createReplyDispatcher({
      ...dispatch.dispatcherOptions,
      beforeDeliver: async () => null,
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "blocked" }, { beforeAgentRunBlocked: true }),
    );
    dispatcher.sendToolResult({ mediaUrl: "https://example.test/tool.png" });
    dispatcher.sendFinalReply({ mediaUrl: "https://example.test/final.png" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(dispatch.deliveredReplies).toEqual([]);
    expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
    expect(markBlocked).not.toHaveBeenCalled();
    expect(receipt?.counts).toMatchObject({
      tool: { cancelled: 1 },
      block: { cancelled: 1 },
      final: { cancelled: 1 },
    });
  });

  it("finalizes media inside the admission without masking dispatch errors", async () => {
    const dispatchError = new Error("dispatch failed");
    const warn = vi.fn();
    let insideAdmission = false;
    let finalizedInsideAdmission = false;
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => {
        finalizedInsideAdmission = insideAdmission;
        throw new Error("finalizer failed");
      },
      logGateway: { warn } as never,
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-finalize",
        sessionKey: "agent:main:main",
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked: vi.fn() },
    });
    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendFinalReply({ mediaUrl: "https://example.test/final.png" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    await expect(
      dispatch.runAgentMediaTranscript(
        {
          run: async (operation) => {
            insideAdmission = true;
            try {
              return await operation();
            } finally {
              insideAdmission = false;
            }
          },
        },
        async () => {
          throw dispatchError;
        },
      ),
    ).rejects.toBe(dispatchError);

    expect(finalizedInsideAdmission).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("webchat media finalization failed: Error: finalizer failed"),
    );
  });
});
