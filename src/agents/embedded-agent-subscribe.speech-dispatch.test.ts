import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createDispatcher,
  emptyConfig,
  replyMediaPathMocks,
  ttsMocks,
} from "../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  firstFinalReplyPayload,
  globalBeforeAll0,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
} from "../auto-reply/reply/dispatch-from-config.test-harness.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./sessions/agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();
beforeAll(globalBeforeAll0);
beforeEach(() => {
  clearRuntimeConfigSnapshot();
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(clearRuntimeConfigSnapshot);

it("keeps the explicit final reply target when captioned TTS defers queued blocks", async () => {
  installCaptionedVoiceTestPlugin("telegram");
  ttsMocks.state.synthesizeFinalAudio = true;
  const rawText =
    "[[reply_to:message-42]]Report ready. [[tts:text]]The report is ready.[[/tts:text]]";
  const pendingMedia = createDeferred();
  const mediaStarted = createDeferred();
  replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(async (payload) => {
    if (payload.mediaUrls?.includes("https://example.com/report.png")) {
      mediaStarted.resolve();
      await pendingMedia.promise;
    }
    return payload;
  });
  let calls = 0;
  streamMocks.streamSimple.mockImplementation(() =>
    createAssistantResultStream(
      createAssistant(
        testModel,
        ++calls === 1
          ? [
              {
                type: "text",
                text: "Preparing your report.\nMEDIA:https://example.com/report.png",
              },
              { type: "toolCall", id: "report-1", name: "report", arguments: {} },
            ]
          : [{ type: "text", text: rawText }],
        calls === 1 ? "toolUse" : "stop",
      ),
    ),
  );
  const { session, sessionManager } = await createTestSession({
    customTools: [
      {
        name: "report",
        label: "Report",
        description: "Prepare the report.",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ready" }], details: undefined }),
      },
    ],
  });
  const dispatcher = createDispatcher();
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "queued-captioned-speech",
        onBlockReply: opts?.onBlockReply,
        onBlockReplyFlush: () => {},
        blockReplyBreak: "message_end",
      });
      const prompt = session.prompt("Prepare a report and reply to message-42.");
      try {
        await mediaStarted.promise;
        await vi.waitFor(() => {
          expect(sessionManager.getEntries()).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                openclawDelivery: {
                  replyToId: "message-42",
                  tts: { tagged: true, text: "The report is ready." },
                },
              }),
            }),
          );
        });
        expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
        pendingMedia.resolve();
        await prompt;
        const assistant = subscription.getCurrentAttemptAssistant();
        return buildPayloads({
          assistantTexts: subscription.assistantTexts,
          currentAssistant: assistant,
          lastAssistant: assistant,
        });
      } finally {
        pendingMedia.resolve();
        try {
          await prompt;
        } finally {
          subscription.unsubscribe();
        }
      }
    },
  });
  expect(dispatcher.sendBlockReply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mediaUrls: ["https://example.com/report.png"], text: undefined }),
  );
  expect(firstFinalReplyPayload(dispatcher)).toMatchObject({
    replyToId: "message-42",
    mediaUrl: "https://example.com/tts-synth.opus",
  });
});
