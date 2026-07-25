// QQBot delivery trace goldens: replayable wire-level lifecycle recordings for
// the budget-constrained REPLACE-mode streaming channel.
//
// Wires the real engine paths the gateway uses — StreamingController
// (engine/messaging/streaming-c2c.ts), the typing keepalive with QQ passive
// reply budget accounting (engine/gateway/typing-keepalive.ts +
// gateway.ts startTypingForEvent), the static block-deliver pipeline
// (engine/gateway/outbound-dispatch.ts deliver wiring →
// engine/messaging/outbound-deliver.ts), and the common budget-limited sender
// path (engine/messaging/sender.ts text/media sends with ReplyLimiter proactive
// fallback) — against a recording ApiClient mock, so
// OUT events are the raw QQ Open Platform HTTP calls. Every wire call that
// carries `msg_id` + `msg_seq` spends QQ's ≤5-per-msg_id passive reply
// budget; typing renewals count against it, which is the point of this
// channel's traces.
//
// The gateway's per-turn glue (markBlockResponse, static fallback ordering,
// the dispatch `finally` finalization) is replicated inline from
// outbound-dispatch.ts; the scripted steps stand in for the dispatcher
// callbacks. Deliberately AS-IS captured behavior (not blessed as ideal):
// - A cancelled run still finalizes the stream via onIdle with a DONE chunk
//   that re-sends the accumulated partial text unchanged (abortStreaming only
//   runs when finalization throws, and performFlush/finalize have no dirty
//   check against the last sent chunk).
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenario,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { TYPING_INPUT_SECOND, TypingKeepAlive } from "./engine/gateway/typing-keepalive.js";
import { createQQBotMarkdownChunker } from "./engine/messaging/markdown-table-chunking.js";
import {
  parseAndSendMediaTags,
  sendPlainReply,
  TEXT_CHUNK_LIMIT,
  type DeliverDeps,
} from "./engine/messaging/outbound-deliver.js";
import { checkMessageReplyLimit, claimMessageReply } from "./engine/messaging/outbound-reply.js";
import {
  sendDocument,
  sendMedia as sendOutboundMedia,
  sendPhoto,
  sendText as sendChannelOutboundText,
  sendVideoMsg,
  sendVoice,
} from "./engine/messaging/outbound.js";
import {
  handleStructuredPayload,
  sendWithTokenRetry,
  type ReplyDispatcherDeps,
} from "./engine/messaging/reply-dispatcher.js";
import {
  accountToCreds,
  clearTokenCache,
  createRawInputNotifyFn,
  getAccessToken,
  sendInputNotify,
} from "./engine/messaging/sender.js";
import {
  StreamingController,
  shouldUseOfficialC2cStream,
} from "./engine/messaging/streaming-c2c.js";
import type { GatewayAccount } from "./engine/types.js";

// Mutable holder shared with the hoisted module mocks. The per-appId account
// registry in sender.ts caches ApiClient instances across scenarios, so the
// mock resolves the active recorder and counters at call time.
const wire = vi.hoisted(() => ({
  recorder: null as {
    recordWireCall: (call: {
      method: string;
      target?: string;
      payload?: unknown;
      result?: unknown;
    }) => void;
  } | null,
  messageCount: 0,
  streamSessionCount: 0,
  uploadCount: 0,
  msgSeqCount: 0,
}));

// Wire seam: every QQ Open Platform REST call funnels through
// ApiClient.request (engine/api/api-client.ts). Record the call in observed
// order and script deterministic results.
vi.mock("./engine/api/api-client.js", () => {
  class RecordingApiClient {
    async request(
      _accessToken: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<unknown> {
      const recorder = wire.recorder;
      if (!recorder) {
        throw new Error("qqbot trace: wire call outside an active scenario");
      }
      let result: unknown;
      if (path.endsWith("/stream_messages")) {
        const request = body as { stream_msg_id?: string };
        if (!request.stream_msg_id) {
          wire.streamSessionCount += 1;
        }
        result = { id: request.stream_msg_id ?? `stream-msg-${wire.streamSessionCount}` };
      } else if (path.endsWith("/files")) {
        wire.uploadCount += 1;
        result = {
          file_uuid: `file-uuid-${wire.uploadCount}`,
          file_info: `file-info-${wire.uploadCount}`,
          ttl: 600,
        };
      } else {
        wire.messageCount += 1;
        result = { id: `wire-msg-${wire.messageCount}`, timestamp: "2026-01-01T00:00:00.000Z" };
      }
      recorder.recordWireCall({ method: `${method} ${path}`, payload: body, result });
      return result;
    }
  }
  return { ApiClient: RecordingApiClient };
});

// Auth seam: token acquisition is plumbing, not delivery lifecycle, so it is
// scripted and never recorded.
vi.mock("./engine/api/token.js", () => {
  class StaticTokenManager {
    async getAccessToken(): Promise<string> {
      return "trace-access-token";
    }
    clearCache(): void {}
    startBackgroundRefresh(): void {}
    stopBackgroundRefresh(): void {}
  }
  return { TokenManager: StaticTokenManager };
});

// Prod getNextMsgSeq is randomized (engine/api/routes.ts); script a counter so
// msg_seq stays deterministic while preserving the semantics the goldens pin:
// one stream session shares a single msg_seq, every other passive send draws a
// fresh one.
vi.mock("./engine/api/routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/api/routes.js")>();
  return {
    ...actual,
    getNextMsgSeq: () => {
      wire.msgSeqCount += 1;
      return wire.msgSeqCount;
    },
  };
});

// Media URL ingestion does a real download in prod; script the bytes so the
// upload body (base64 file_data) is deterministic. MediaApi itself stays real.
vi.mock("./engine/api/media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/api/media.js")>();
  return {
    ...actual,
    downloadDirectUploadUrl: async () => Buffer.from("qqbot-trace-image-bytes"),
  };
});

const APP_ID = "trace-app-id";
const OPENID = "user-openid-trace";
const QUALIFIED_TARGET = `qqbot:c2c:${OPENID}`;

// Streaming-enabled C2C account without markdown permission — the common
// plain-text account shape; quoting stays available and no image-size probes run.
const ACCOUNT: GatewayAccount = {
  accountId: "main",
  appId: APP_ID,
  // Placeholder credential; token acquisition is mocked and the value never
  // reaches a recorded wire payload.
  clientSecret: "trace-cred",
  markdownSupport: false,
  config: { streaming: { mode: "partial", nativeTransport: true } },
};

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

function setupQqbotTrace(recorder: WireRecorder, msgId: string) {
  wire.recorder = recorder;
  wire.messageCount = 0;
  wire.streamSessionCount = 0;
  wire.uploadCount = 0;
  wire.msgSeqCount = 0;

  const account = ACCOUNT;
  const event = { type: "c2c" as const, senderId: OPENID, messageId: msgId };
  let keepAlive: TypingKeepAlive | null = null;

  // outbound-dispatch.ts builds the controller only for official C2C stream
  // accounts; derive it through the real predicate.
  const streamingController = shouldUseOfficialC2cStream(account, "c2c")
    ? new StreamingController({
        account,
        userId: event.senderId,
        replyToMsgId: event.messageId,
        eventId: event.messageId,
        logPrefix: `[qqbot:${account.accountId}:streaming]`,
        log: silentLog,
        // Scenario media rides an https URL, so no workspace media roots are wired.
        mediaContext: { account, event, log: silentLog },
      })
    : null;
  if (!streamingController) {
    throw new Error("qqbot trace expects the official C2C stream account shape");
  }

  const markdownChunker = createQQBotMarkdownChunker((text, limit) =>
    chunkMarkdownText(text, limit),
  );
  const deliverDeps: DeliverDeps = {
    mediaSender: {
      sendPhoto: (target, imageUrl) => sendPhoto(target, imageUrl),
      sendVoice: (target, voicePath, uploadFormats, transcodeEnabled) =>
        sendVoice(target, voicePath, uploadFormats, transcodeEnabled),
      sendVideoMsg: (target, videoPath) => sendVideoMsg(target, videoPath),
      sendDocument: (target, filePath) => sendDocument(target, filePath),
      sendMedia: (opts) => sendOutboundMedia(opts),
    },
    chunkText: (text, limit) => markdownChunker.chunkText(text, limit),
  };
  const replyDeps: ReplyDispatcherDeps = {
    tts: {
      textToSpeech: async () => ({ success: false }),
      audioFileToSilkBase64: async () => undefined,
    },
  };
  const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
    sendWithTokenRetry(account.appId, account.clientSecret, sendFn, silentLog, account.accountId);
  const deliverEvent = { type: event.type, senderId: event.senderId, messageId: event.messageId };
  const deliverActx = { account, qualifiedTarget: QUALIFIED_TARGET, log: silentLog };
  const replyCtx = { target: deliverEvent, account, cfg: {}, log: silentLog };

  // Replica of outbound-dispatch.ts markBlockResponse: the first block deliver
  // stops the typing keepalive so the reserved passive reply stays available.
  const markBlockResponse = () => {
    keepAlive?.stop();
  };

  // Replica of the outbound-dispatch.ts block-deliver wiring for a visible
  // final payload (silent/media-only gates and group-skip branches are not
  // exercised by these scripts). Deliver-first finals lock the controller and
  // fall back to the static sender path, which shares the same passive budget
  // and proactive fallback as channel outbound sends.
  const deliverFinal = async (payload: {
    text?: string;
    mediaUrls?: string[];
    isError?: boolean;
  }) => {
    markBlockResponse();
    if (!streamingController.isTerminalPhase) {
      await streamingController.onDeliver(payload);
      if (!streamingController.shouldFallbackToStatic) {
        return;
      }
    }
    // Static fallback pipeline: media tags → structured payload → plain reply.
    const consumeQuoteRef = () => undefined;
    let replyText = payload.text ?? "";
    const mediaResult = await parseAndSendMediaTags(
      replyText,
      deliverEvent,
      deliverActx,
      sendWithRetry,
      consumeQuoteRef,
      deliverDeps,
    );
    if (mediaResult.handled) {
      return;
    }
    replyText = mediaResult.normalizedText;
    if (await handleStructuredPayload(replyCtx, replyText, () => {}, replyDeps)) {
      return;
    }
    await sendPlainReply(
      payload,
      replyText,
      deliverEvent,
      deliverActx,
      sendWithRetry,
      consumeQuoteRef,
      [],
      deliverDeps,
    );
  };

  // tool-progress "result" steps stand in for message-tool sends replying to
  // the same inbound message. Those ride the channel outbound seam
  // (channel.ts sendText → outbound.ts sendText → sender.ts sendText), which
  // shares one five-request budget with typing and static final delivery.
  let toolSendCount = 0;
  const sendViaChannelOutbound = async () => {
    toolSendCount += 1;
    await sendChannelOutboundText({
      to: QUALIFIED_TARGET,
      text: `Reply ${toolSendCount} via message tool`,
      replyToId: msgId,
      account,
    });
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start": {
        // Replica of gateway.ts startTypingForEvent: initial input_notify
        // (first budget spend), then the keepalive loop with
        // TYPING_RENEWAL_LIMIT renewals reserving one reply for the final.
        const passive = claimMessageReply(msgId, 1);
        if (!passive.allowed) {
          break;
        }
        await sendInputNotify({
          openid: OPENID,
          creds: accountToCreds(account),
          msgId,
          inputSecond: TYPING_INPUT_SECOND,
        });
        keepAlive = new TypingKeepAlive(
          () => getAccessToken(account.appId, account.clientSecret),
          () => clearTokenCache(account.appId),
          createRawInputNotifyFn(account.appId),
          OPENID,
          msgId,
          silentLog,
        );
        keepAlive.start();
        break;
      }
      case "partial":
        // replyOptions.onPartialReply wiring (outbound-dispatch.ts).
        await streamingController.onPartialReply({ text: step.text });
        break;
      case "block-final":
        // REPLACE-mode streaming has no per-block wire effect: the controller
        // infers the boundary from the next partial's raw-prefix mismatch and
        // joins with "\n\n" (streaming-c2c.ts boundary handling).
        break;
      case "tool-progress":
        await sendViaChannelOutbound();
        break;
      case "final":
        await deliverFinal({
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
          ...(step.isError ? { isError: true } : {}),
        });
        break;
      case "cancel":
        // An aborted run stops emitting payloads; closeout happens on idle,
        // mirroring dispatchOutbound's finally.
        break;
      case "idle": {
        // Replica of dispatchOutbound's finally, then handleMessage's finally
        // (gateway.ts): finalize the stream, then stop typing.
        const pendingMarkdown = markdownChunker.flushPendingText(TEXT_CHUNK_LIMIT);
        if (pendingMarkdown.length > 0) {
          // These scripts never split markdown tables; pending text here means
          // the scenario drifted from the flushPendingMarkdownText assumption.
          throw new Error("qqbot trace: unexpected pending markdown-table text");
        }
        if (!streamingController.isTerminalPhase) {
          streamingController.markFullyComplete();
          await streamingController.onIdle();
        }
        keepAlive?.stop();
        break;
      }
      case "wire-fault":
        throw new Error("qqbot trace scenarios do not script wire faults");
    }
  };
}

const MEDIA_INTERRUPT_FULL_TEXT =
  "Here is the chart:\n<qqimg>https://example.com/chart.png</qqimg>\nKey takeaways: ship it.";

const QQBOT_TRACE_SCENARIOS: readonly DeliveryTraceScenario[] = [
  // Official REPLACE-mode stream lifecycle over the shared streaming-happy
  // script: one stream session, cumulative GENERATING chunks, boundary joined
  // with "\n\n", DONE chunk sealing the full text.
  { name: "streaming-happy-c2c", steps: deliveryTraceScenarios["streaming-happy"].steps },
  // Budget lifecycle against one msg_id: initial input_notify plus exactly
  // TYPING_RENEWAL_LIMIT (3) renewals, then a renewal-free tick proving the
  // reserved final reply; five message-tool sends where only the first can
  // claim the fifth passive slot; then a static final. Every later text send
  // falls back to a proactive body without msg_id/msg_seq.
  {
    name: "budget-exhaustion",
    steps: [
      { kind: "reply-start" },
      { kind: "advance", ms: 5000 },
      { kind: "advance", ms: 5000 },
      { kind: "advance", ms: 5000 },
      { kind: "advance", ms: 5000 },
      { kind: "tool-progress", name: "message", phase: "result" },
      { kind: "tool-progress", name: "message", phase: "result" },
      { kind: "tool-progress", name: "message", phase: "result" },
      { kind: "tool-progress", name: "message", phase: "result" },
      { kind: "tool-progress", name: "message", phase: "result" },
      { kind: "final", text: "Budget check complete." },
      { kind: "idle" },
    ],
  },
  deliveryTraceScenarios["final-only"],
  deliveryTraceScenarios["cancel-mid-stream"],
  // Media arriving mid-stream interrupts the session: DONE chunk for the text
  // before the tag, synchronous upload + media message (both budget spends),
  // then a fresh stream session with a new stream_msg_id and msg_seq resumes
  // the remaining text.
  {
    name: "media-interrupt",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Here is the chart:" },
      { kind: "advance", ms: 300 },
      { kind: "partial", text: MEDIA_INTERRUPT_FULL_TEXT },
      { kind: "advance", ms: 300 },
      { kind: "final", text: MEDIA_INTERRUPT_FULL_TEXT },
      { kind: "idle" },
    ],
  },
];

const EXPECTED_REPLY_BUDGET_REMAINING: Readonly<Record<string, number>> = {
  "streaming-happy-c2c": 3,
  "budget-exhaustion": 0,
  "media-interrupt": 1,
};

describe("qqbot delivery trace goldens", () => {
  for (const scenario of QQBOT_TRACE_SCENARIOS) {
    const scenarioName = scenario.name;
    it(`records ${scenarioName}`, async () => {
      const msgId = `qq-msg-${scenarioName}`;
      try {
        const events = await runDeliveryTraceScenario({
          scenario,
          // Distinct msg_id per scenario keeps the module-global ReplyLimiter
          // and upload caches from leaking budget state across scenarios.
          setup: (recorder) => setupQqbotTrace(recorder, msgId),
        });
        expectDeliveryTraceMatchesGolden({
          goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
          events,
        });
        const expectedRemaining = EXPECTED_REPLY_BUDGET_REMAINING[scenarioName];
        if (expectedRemaining !== undefined) {
          const finalOffsetMs = events.at(-1)?.at ?? 0;
          vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) + finalOffsetMs });
          try {
            // Each stream session and media message consumes one shared slot;
            // uploads and later chunks within a session do not.
            expect(checkMessageReplyLimit(msgId).remaining).toBe(expectedRemaining);
          } finally {
            vi.useRealTimers();
          }
        }
      } finally {
        wire.recorder = null;
      }
    });
  }
});
