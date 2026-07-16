// Telegram delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the REAL dispatcher wiring: buildTelegramMessageContext builds the
// turn context, dispatchTelegramMessage builds its draft lanes and deliver
// glue, and the injected dispatchReplyWithBufferedBlockDispatcher seam captures
// the exact dispatcher/reply options the SDK reply dispatcher would consume.
// The scripted IN steps stand in for the model loop; OUT events are the grammY
// Bot API calls (sendMessage / editMessageText / sendChatAction /
// deleteMessage) observed at a recording API mock with scripted message ids.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import type { Bot } from "grammy";
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest,
} from "./bot-message-context.test-harness.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { resetTelegramReplyFenceForTest as resetTelegramReplyFenceForTests } from "./runtime.test-support.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

type RecordedWireCall = Parameters<WireRecorder["recordWireCall"]>[0];
type BufferedDispatcherParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type BufferedDispatcherResult = Awaited<
  ReturnType<TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]>
>;

const TRACE_CHAT_ID = 4242;
// The scripted preview-delete dwell (MIN_PREVIEW_DWELL_MS = 4s) plus margin, so
// the detached teardown delete of an unfinalized preview lands in the trace.
const TRACE_TEARDOWN_ADVANCE_MS = 5_000;

type TelegramTraceWireState = {
  recordWireCall: (call: RecordedWireCall) => void;
  /** Faults consumed by the next editMessageText call (flood-wait script). */
  wireFaults: Array<{ retryAfterMs: number }>;
};

function compactParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(params as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );
}

function createRecordingTelegramApi(state: TelegramTraceWireState): Bot["api"] {
  let messageCount = 1000;
  const nextMessageId = () => {
    messageCount += 1;
    return messageCount;
  };
  const api = {
    sendMessage: (chatId: number | string, text: string, params?: Record<string, unknown>) => {
      const message_id = nextMessageId();
      state.recordWireCall({
        method: "sendMessage",
        target: String(chatId),
        payload: { text, ...compactParams(params) },
        result: { message_id },
      });
      return Promise.resolve({ message_id });
    },
    editMessageText: (
      chatId: number | string,
      messageId: number,
      text: string,
      params?: Record<string, unknown>,
    ) => {
      const fault = state.wireFaults.shift();
      if (fault) {
        const retryAfterS = Math.ceil(fault.retryAfterMs / 1000);
        state.recordWireCall({
          method: "editMessageText",
          target: String(chatId),
          payload: { message_id: messageId, text, ...compactParams(params) },
          result: { error_code: 429, parameters: { retry_after: retryAfterS } },
        });
        // Mirrors grammY's GrammyError surface for a Bot API flood wait: the
        // structured error_code/parameters fields drive isTelegramRateLimitError
        // and readTelegramRetryAfterMs in the preview suspension path.
        return Promise.reject(
          Object.assign(new Error(`429: Too Many Requests: retry after ${retryAfterS}`), {
            error_code: 429,
            parameters: { retry_after: retryAfterS },
          }),
        );
      }
      state.recordWireCall({
        method: "editMessageText",
        target: String(chatId),
        payload: { message_id: messageId, text, ...compactParams(params) },
        result: true,
      });
      return Promise.resolve(true);
    },
    sendChatAction: (
      chatId: number | string,
      action: string,
      params?: Record<string, unknown>,
    ): Promise<true> => {
      state.recordWireCall({
        method: "sendChatAction",
        target: String(chatId),
        payload: { action, ...compactParams(params) },
        result: true,
      });
      return Promise.resolve(true);
    },
    deleteMessage: (chatId: number | string, messageId: number) => {
      state.recordWireCall({
        method: "deleteMessage",
        target: String(chatId),
        payload: { message_id: messageId },
        result: true,
      });
      return Promise.resolve(true);
    },
    setMessageReaction: () => Promise.resolve(true),
  };
  return api as unknown as Bot["api"];
}

function createTraceTelegramDeps(captured: {
  dispatcherOptions?: BufferedDispatcherParams["dispatcherOptions"];
  replyOptions?: BufferedDispatcherParams["replyOptions"];
  resolveDispatch?: (result: BufferedDispatcherResult) => void;
}): TelegramBotDeps {
  return {
    getRuntimeConfig: (() => ({
      config: baseTelegramMessageContextConfig,
    })) as unknown as TelegramBotDeps["getRuntimeConfig"],
    resolveStorePath: (() =>
      "/tmp/openclaw-trace-unused.json") as TelegramBotDeps["resolveStorePath"],
    // No session entry: keeps the transcript mirror and final-text recovery
    // inert so the trace stays a pure wire recording.
    getSessionEntry: (() => undefined) as TelegramBotDeps["getSessionEntry"],
    readChannelAllowFromStore: (async () => []) as TelegramBotDeps["readChannelAllowFromStore"],
    upsertChannelPairingRequest: (async () => ({
      code: "TRACE",
      created: false,
    })) as unknown as TelegramBotDeps["upsertChannelPairingRequest"],
    enqueueSystemEvent: (async () => {}) as unknown as TelegramBotDeps["enqueueSystemEvent"],
    // The capture seam: dispatchTelegramMessage hands the SDK reply dispatcher
    // its deliver wiring here; the trace drives those callbacks directly and
    // resolves this promise at the scripted idle step, exactly where the real
    // agent loop would settle.
    dispatchReplyWithBufferedBlockDispatcher: ((params: BufferedDispatcherParams) => {
      captured.dispatcherOptions = params.dispatcherOptions;
      captured.replyOptions = params.replyOptions;
      return new Promise((resolve) => {
        captured.resolveDispatch = resolve;
      });
    }) as TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"],
    buildModelsProviderData: (async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-test" },
      modelNames: new Map<string, string>(),
    })) as unknown as TelegramBotDeps["buildModelsProviderData"],
    listSkillCommandsForAgents:
      (() => []) as unknown as TelegramBotDeps["listSkillCommandsForAgents"],
    wasSentByBot: (() => false) as TelegramBotDeps["wasSentByBot"],
    deliverInboundReplyWithMessageSendContext: (async () => ({
      status: "unsupported",
      reason: "missing_outbound_handler",
    })) as unknown as TelegramBotDeps["deliverInboundReplyWithMessageSendContext"],
    emitInternalMessageSentHook: (() => {}) as TelegramBotDeps["emitInternalMessageSentHook"],
    recordOutboundMessageForPromptContext: (async () =>
      true) as TelegramBotDeps["recordOutboundMessageForPromptContext"],
  };
}

async function setupTelegramTrace(recorder: WireRecorder) {
  resetTelegramReplyFenceForTests();
  const state: TelegramTraceWireState = {
    recordWireCall: recorder.recordWireCall,
    wireFaults: [],
  };
  const api = createRecordingTelegramApi(state);
  // Real per-account handler so typing choreography (401 backoff, cooldowns)
  // runs the production path over the recording API.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      api.sendChatAction(chatId, action, threadParams) as Promise<true>,
    logger: () => {},
  });
  // Real context construction (route, thread spec, typing cue, turn record);
  // ingress/spool stays out of scope — the context build is the delivery-side
  // boundary the dispatcher consumes.
  const context = await buildTelegramMessageContextForTest({
    message: {
      message_id: 1,
      date: 1_700_000_000,
      text: "run the deploy",
      from: { id: 42, first_name: "Alice" },
      chat: { id: TRACE_CHAT_ID, type: "private" },
    },
    botApi: api as unknown as Record<string, unknown>,
    sendChatActionHandler,
  });
  if (!context) {
    throw new Error("trace context was not built");
  }
  const captured: Parameters<typeof createTraceTelegramDeps>[0] = {};
  const dispatchDone = dispatchTelegramMessage({
    context,
    bot: { api } as unknown as Bot,
    cfg: baseTelegramMessageContextConfig,
    runtime: { log: () => {}, error: () => {} } as unknown as RuntimeEnv,
    // "first" is the single-use reply mode: the first visible message consumes
    // the reply target (prod default is "off", which would hide that contract).
    replyToMode: "first",
    streamMode: "partial",
    textLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
    telegramCfg: {},
    telegramDeps: createTraceTelegramDeps(captured),
    opts: { token: "trace-token" },
  });
  // Swallow here only to avoid an unhandled rejection warning racing the idle
  // step; the idle handler awaits dispatchDone and surfaces real failures.
  dispatchDone.catch(() => {});
  for (let drain = 0; drain < 50 && !captured.dispatcherOptions; drain += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
  const options = captured.dispatcherOptions;
  const replyOptions = captured.replyOptions;
  if (!options || !replyOptions || !captured.resolveDispatch) {
    throw new Error("dispatcher options were not captured");
  }

  const pendingFinals: Array<Promise<void>> = [];
  let armedRetryAfterMs = 0;
  const counts = { tool: 0, block: 0, final: 0 };
  const deliverPayload = async (payload: ReplyPayload, info: { kind: "block" | "final" }) => {
    // Mirror the real dispatcher order: beforeDeliver (identity for telegram),
    // then deliver with the block's assistant-message context.
    const deliverInfo =
      info.kind === "block" ? { kind: info.kind, assistantMessageIndex: 0 } : { kind: info.kind };
    const prepared = (await options.beforeDeliver?.(payload, deliverInfo)) ?? payload;
    await options.deliver(prepared, deliverInfo);
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options.typingCallbacks?.onReplyStart?.();
        break;
      case "partial":
        await replyOptions?.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        counts.block += 1;
        await replyOptions?.onBlockReplyQueued?.({ text: step.text }, { assistantMessageIndex: 0 });
        await deliverPayload({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        await replyOptions?.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final": {
        counts.final += 1;
        const payload: ReplyPayload = {
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
          ...(step.isError ? { isError: true } : {}),
        };
        // Not awaited inline: a flood-suspended final parks inside the draft
        // stream's retry_after wait, so the idle step advances the clock past
        // the suspension and settles it there instead of deadlocking here.
        const delivery = deliverPayload(payload, { kind: "final" });
        delivery.catch(() => {});
        pendingFinals.push(delivery);
        break;
      }
      case "cancel":
        // An aborted run stops emitting payloads; teardown happens on idle.
        break;
      case "wire-fault":
        if (step.fault !== "rate-limit") {
          throw new Error("telegram trace scenarios script only rate-limit wire faults");
        }
        state.wireFaults.push({ retryAfterMs: step.retryAfterMs });
        armedRetryAfterMs = step.retryAfterMs;
        break;
      case "idle": {
        await vi.advanceTimersByTimeAsync(0);
        if (armedRetryAfterMs > 0) {
          // Drain the flood suspension: the preview engine holds the newest
          // snapshot until retry_after expires, then flushes it in one edit.
          await vi.advanceTimersByTimeAsync(armedRetryAfterMs);
        }
        await Promise.all(pendingFinals);
        options.typingCallbacks?.onIdle?.();
        options.typingCallbacks?.onCleanup?.();
        captured.resolveDispatch?.({ queuedFinal: false, counts });
        await dispatchDone;
        // Unfinalized previews are torn down with a detached delete behind the
        // on-screen dwell; advance past it so the teardown lands in the trace.
        await vi.advanceTimersByTimeAsync(TRACE_TEARDOWN_ADVANCE_MS);
        break;
      }
    }
  };
}

const TELEGRAM_TRACE_SCENARIOS: readonly DeliveryTraceScenarioName[] = [
  "streaming-happy",
  "final-only",
  "cancel-mid-stream",
  "rate-limit-during-preview",
  "overflow-pagination",
];

describe("telegram delivery trace goldens", () => {
  for (const scenarioName of TELEGRAM_TRACE_SCENARIOS) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[scenarioName],
        setup: setupTelegramTrace,
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
