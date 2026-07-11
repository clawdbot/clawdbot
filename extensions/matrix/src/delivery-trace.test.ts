// Matrix delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the real monitor handler (createMatrixRoomMessageHandler) end to end
// through the shared handler test harness: IN steps map onto the captured
// reply-dispatcher wiring (deliver, typing callbacks, onPartialReply,
// onBlockReplyQueued, onAssistantMessageStart), OUT events are the raw Matrix
// client calls (sendMessage/getEvent/redactEvent/setTyping/sendReadReceipt)
// observed at a recording client. The room is plain (E2EE out of scope), so
// goldens capture wire content and event-id semantics: every m.replace edit
// mints a new event id while the logical target id stays stable, and previews
// are mentions-inert until a final either edits in place or gets redacted and
// re-sent as a fresh mention-bearing event.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenario,
  type DeliveryTraceScenarioName,
  type DeliveryTraceStep,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, describe, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./matrix/monitor/handler.test-helpers.js";
import type { MatrixClient } from "./matrix/sdk.js";
import type { PluginRuntime, ReplyPayload } from "./runtime-api.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const ROOM_ID = "!room:example.org";
const BOT_USER_ID = "@openclaw:example.org";
const INBOUND_EVENT_ID = "$inbound-1";

beforeAll(() => {
  // send.ts/replies.ts read text helpers and the monitor's mention gating from
  // the module runtime slot; bind the real chunking/table implementations so
  // rendered wire content is part of the recorded lifecycle (mirrors the
  // feishu adoption's runtime stub). Media helpers stay absent: these
  // scenarios are text-only and a media lookup should fail loudly.
  installMatrixTestRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
        resolveTextChunkLimit,
        resolveChunkMode,
        chunkMarkdownTextWithMode,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((pattern) => pattern.test(text)),
        matchesMentionWithExplicit: () => false,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
    } as unknown as PluginRuntime["channel"],
  });
});

function createRecordingMatrixClient(recorder: WireRecorder): Partial<MatrixClient> {
  // Deterministic sequential event ids replace homeserver-minted opaque ids
  // (the normalizer seam from the trace spec, applied at the mock boundary):
  // every event on the wire consumes one id, so goldens show edits minting new
  // ids while their m.relates_to target stays the original event.
  const eventContentById = new Map<string, Record<string, unknown>>();
  let eventCount = 0;
  const mintEventId = () => {
    eventCount += 1;
    return `$e${eventCount}`;
  };
  const client: Partial<MatrixClient> = {
    getUserId: async () => BOT_USER_ID,
    sendMessage: async (roomId: string, content: Record<string, unknown>) => {
      const eventId = mintEventId();
      // Snapshot before recording: edit flows reuse content structures, and the
      // recorder serializes at compare time.
      const payload = structuredClone(content);
      eventContentById.set(eventId, payload);
      recorder.recordWireCall({
        method: "sendMessage",
        target: roomId,
        payload,
        result: { event_id: eventId },
      });
      return eventId;
    },
    // editMessageMatrix fetches the prior event before every edit (mention
    // diffing / thread guard) — an extra RTT per edit that the trace captures
    // even for mentions-inert previews where the result goes unused.
    getEvent: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({
        method: "getEvent",
        target: eventId,
        result: { found: eventContentById.has(eventId) },
      });
      return { event_id: eventId, content: eventContentById.get(eventId) ?? {} };
    },
    redactEvent: async (_roomId: string, eventId: string) => {
      // Redactions are events too: abandoning a draft consumes an event id.
      const redactionEventId = mintEventId();
      recorder.recordWireCall({
        method: "redactEvent",
        target: eventId,
        result: { event_id: redactionEventId },
      });
      return redactionEventId;
    },
    setTyping: async (roomId: string, typing: boolean, timeoutMs: number) => {
      recorder.recordWireCall({
        method: "setTyping",
        target: roomId,
        payload: { typing, timeoutMs },
      });
    },
    sendReadReceipt: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({ method: "sendReadReceipt", target: eventId });
    },
  };
  return client;
}

type MatrixTraceDeliver = (payload: ReplyPayload, info: { kind: string }) => Promise<void>;

type MatrixTraceReplyOptions = {
  onPartialReply?: (payload: { text: string }) => void;
  onBlockReplyQueued?: (
    payload: { text?: string },
    context?: { assistantMessageIndex?: number },
  ) => Promise<void> | void;
  onAssistantMessageStart?: () => void;
};

async function setupMatrixTrace(recorder: WireRecorder) {
  const client = createRecordingMatrixClient(recorder);

  let capturedDeliver: MatrixTraceDeliver | undefined;
  let capturedOnReplyStart: (() => Promise<void> | void) | undefined;
  let capturedOnIdle: (() => void) | undefined;
  let capturedReplyOptions: MatrixTraceReplyOptions | undefined;
  let resolveCaptured: (() => void) | undefined;
  const captured = new Promise<void>((resolve) => {
    resolveCaptured = resolve;
  });
  const notifyCaptured = () => {
    if (capturedDeliver && capturedReplyOptions) {
      resolveCaptured?.();
    }
  };

  // The scripted steps stand in for the model run: dispatchReplyFromConfig
  // stays pending until the script's final/cancel step settles it, so the
  // handler's post-dispatch flow (including the finally-block draft abandon
  // path) runs exactly where the real run would settle.
  type DispatchResult = { queuedFinal: boolean; counts: { final: number; block: number } };
  let releaseRun: ((result: DispatchResult) => void) | undefined;
  const runGate = new Promise<DispatchResult>((resolve) => {
    releaseRun = resolve;
  });

  const { handler } = createMatrixHandlerTestHarness({
    streaming: "partial",
    blockStreamingEnabled: true,
    client,
    resolveMarkdownTableMode: () => resolveMarkdownTableMode({ cfg: {}, channel: "matrix" }),
    createReplyDispatcherWithTyping: (options: Record<string, unknown> | undefined) => {
      capturedDeliver = options?.deliver as MatrixTraceDeliver | undefined;
      capturedOnReplyStart = options?.onReplyStart as typeof capturedOnReplyStart;
      capturedOnIdle = options?.onIdle as typeof capturedOnIdle;
      notifyCaptured();
      return {
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      };
    },
    dispatchReplyFromConfig: (async (args: { replyOptions?: MatrixTraceReplyOptions }) => {
      capturedReplyOptions = args?.replyOptions;
      notifyCaptured();
      const result = await runGate;
      return { queuedFinal: result.queuedFinal, counts: { ...result.counts, tool: 0 } };
    }) as never,
  });

  const handlerDone = handler(
    ROOM_ID,
    createMatrixTextMessageEvent({
      eventId: INBOUND_EVENT_ID,
      body: "deploy status?",
      originServerTs: Date.now(),
    }),
  );
  await Promise.race([
    captured,
    handlerDone.then(() => {
      throw new Error("matrix handler settled before capturing dispatcher wiring");
    }),
  ]);
  // Drain the fire-and-forget inbound read receipt so it lands at a fixed
  // position (before the first scripted step) in every recording.
  await vi.advanceTimersByTimeAsync(0);

  // Mirrors the runner's assistant message_start boundaries: the first index
  // is minted at reply start and each tool round ends with the next assistant
  // message beginning (handler resets its cumulative-text offsets there).
  let assistantMessageIndex = 0;
  const startAssistantMessage = () => {
    assistantMessageIndex += 1;
    capturedReplyOptions?.onAssistantMessageStart?.();
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await capturedOnReplyStart?.();
        startAssistantMessage();
        break;
      case "partial":
        // Cumulative text for the current assistant message; the handler
        // slices it into per-generation draft updates.
        capturedReplyOptions?.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await capturedReplyOptions?.onBlockReplyQueued?.(
          { text: step.text },
          { assistantMessageIndex },
        );
        await capturedDeliver?.({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        // Preview tool progress is not adopted here; a completed tool round
        // means the next assistant message (generation) starts streaming.
        if (step.phase === "result") {
          startAssistantMessage();
        }
        break;
      case "final":
        await capturedDeliver?.(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        releaseRun?.({ queuedFinal: true, counts: { final: 1, block: 0 } });
        await handlerDone;
        break;
      case "cancel":
        // An aborted run settles the dispatch without a final payload; the
        // handler's finally block flushes and redacts the unconsumed draft.
        releaseRun?.({ queuedFinal: false, counts: { final: 0, block: 0 } });
        await handlerDone;
        break;
      case "idle":
        capturedOnIdle?.();
        break;
      case "wire-fault":
        throw new Error("matrix trace scenarios do not script wire faults");
    }
  };
}

// Matrix records generation-scoped edit-streaming shapes the shared v1
// library does not model; the runner treats the scenario name as opaque data
// (it only keys the golden filename), so widening the closed union stays
// test-local instead of leaking matrix names into the core scenario library.
function matrixScenario(name: string, steps: readonly DeliveryTraceStep[]): DeliveryTraceScenario {
  return { name: name as DeliveryTraceScenarioName, steps };
}

const GEN_ONE_PARTIAL = "Build check:";
const GEN_ONE_BLOCK = "Build check: all suites green.";
const GEN_TWO_PARTIAL = "Deploying to production now.";
const GEN_TWO_PREVIEW = "Deploying to production now. Watching health checks.";
const GEN_TWO_FINAL = "Deploying to production now. Health checks green.";
const IN_PLACE_PARTIAL = "Ship checklist complete.";
const IN_PLACE_FINAL = "Ship checklist complete. Tagging the release.";
const MENTION_PARTIAL = "Paging @oncall:example.org";
const MENTION_FINAL = "Paging @oncall:example.org for the deploy review.";

// The draft stream throttles edits at 1000ms; each generation streams one
// create plus one throttled m.replace edit before its boundary settles it.
const MATRIX_TRACE_SCENARIOS: readonly DeliveryTraceScenario[] = [
  // Two generations separated by a tool round: one preview event per
  // generation, cumulative slices, block finalize-in-place for generation one,
  // and a final replace-edit because the final text differs from the last
  // rendered preview of generation two.
  matrixScenario("streaming-happy-multi-generation", [
    { kind: "reply-start" },
    { kind: "partial", text: GEN_ONE_PARTIAL },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: GEN_ONE_BLOCK },
    { kind: "advance", ms: 700 },
    { kind: "block-final", text: GEN_ONE_BLOCK },
    { kind: "tool-progress", name: "deploy", phase: "start" },
    { kind: "tool-progress", name: "deploy", phase: "result" },
    { kind: "partial", text: GEN_TWO_PARTIAL },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: GEN_TWO_PREVIEW },
    { kind: "advance", ms: 700 },
    { kind: "final", text: GEN_TWO_FINAL },
    { kind: "idle" },
  ]),
  // Final text equals the last rendered preview: the draft is finalized in
  // place with an edit that only clears the MSC4357 live marker.
  matrixScenario("final-in-place", [
    { kind: "reply-start" },
    { kind: "partial", text: IN_PLACE_PARTIAL },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: IN_PLACE_FINAL },
    { kind: "advance", ms: 700 },
    { kind: "final", text: IN_PLACE_FINAL },
    { kind: "idle" },
  ]),
  // Previews are mentions-inert and an edit cannot retro-notify, so a final
  // whose text would activate mentions redacts the preview and re-sends the
  // final as a fresh mention-bearing event.
  matrixScenario("final-mentions-fresh", [
    { kind: "reply-start" },
    { kind: "partial", text: MENTION_PARTIAL },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: MENTION_FINAL },
    { kind: "advance", ms: 700 },
    { kind: "final", text: MENTION_FINAL },
    { kind: "idle" },
  ]),
  // Shared abandon shape: the handler's finally block flushes the pending
  // throttled edit, then redacts the unconsumed draft.
  deliveryTraceScenarios["cancel-mid-stream"],
];

describe("matrix delivery trace goldens", () => {
  for (const scenario of MATRIX_TRACE_SCENARIOS) {
    it(`records ${scenario.name}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario,
        setup: setupMatrixTrace,
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenario.name}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
