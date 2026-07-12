// MSTeams delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the real createMSTeamsReplyDispatcher + createTeamsReplyStreamController
// wiring (typing keepalive, append-only native stream, block batching) against a
// mocked Bot Framework turn context. OUT events are the raw SDK surface calls:
// context.sendActivity activities and stream.emit/update/close writes.
//
// msteams cancel has no inbound event: user Stop makes Teams 403 the next chunk
// and the SDK throws StreamCancelledError synchronously from the write, so the
// cancel scenario arms a stream write fault at setup and maps the scripted
// `cancel` step to nothing. A non-cancel write fault latches streamFailed and
// the full reply is intentionally re-delivered as blocks even though a prefix
// already streamed (duplication over truncation — see reply-stream-controller).
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, it } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "../runtime-api.js";
import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

/** Options msteams passes into core createReplyDispatcherWithTyping (capture seam). */
type CapturedDispatcherOptions = {
  onReplyStart?: () => Promise<void> | void;
  deliver: (payload: ReplyPayload, info: { kind: string }) => Promise<void> | void;
  typingCallbacks?: { onIdle?: () => void };
};

/**
 * Deterministic stream write fault. Writes are counted across emit/update/close;
 * the fault fires at `atWrite` and every later write, matching a broken or
 * canceled SDK HttpStream that stays broken for the rest of the turn.
 */
type StreamWriteFault = { atWrite: number; kind: "cancelled" | "broken" };

function createStreamCancelledError(): Error {
  // The controller matches by err.name (the SDK class re-export is not
  // resolvable), so the mock only needs the name to be contract-accurate.
  const err = new Error("stream cancelled by user Stop");
  err.name = "StreamCancelledError";
  return err;
}

function createRecordingStream(recorder: WireRecorder, fault?: StreamWriteFault) {
  let writes = 0;
  let canceled = false;
  const applyFault = (method: string, payload?: unknown): void => {
    writes += 1;
    if (!fault || writes < fault.atWrite) {
      return;
    }
    if (fault.kind === "cancelled") {
      // SDK behavior on user Stop: the chunk POST 403s, the streamer flips its
      // canceled flag, and this and every later write throws StreamCancelledError.
      canceled = true;
      recorder.recordWireCall({
        method,
        ...(payload !== undefined ? { payload } : {}),
        result: { error: "StreamCancelledError" },
      });
      throw createStreamCancelledError();
    }
    recorder.recordWireCall({
      method,
      ...(payload !== undefined ? { payload } : {}),
      result: { error: "stream write failed" },
    });
    throw new Error("Teams stream write failed");
  };
  return {
    emit(activity: unknown): void {
      const payload = typeof activity === "string" ? { text: activity } : activity;
      applyFault("stream.emit", payload);
      recorder.recordWireCall({ method: "stream.emit", payload });
    },
    update(text: string): void {
      applyFault("stream.update", { text });
      recorder.recordWireCall({ method: "stream.update", payload: { text } });
    },
    clearText(): void {},
    async close(): Promise<unknown> {
      applyFault("stream.close");
      recorder.recordWireCall({ method: "stream.close", result: { id: "stream-final" } });
      return { id: "stream-final" };
    },
    get canceled(): boolean {
      return canceled;
    },
  };
}

function createRecordingTurnContext(params: {
  recorder: WireRecorder;
  conversationId: string;
  conversationType: string;
  stream: ReturnType<typeof createRecordingStream>;
}): MSTeamsTurnContext {
  let activityCount = 0;
  const reject = (method: string) => async () => {
    throw new Error(`unexpected turn-context call: ${method}`);
  };
  return {
    activity: {
      type: "message",
      conversation: { id: params.conversationId, conversationType: params.conversationType },
    },
    sendActivity: async (activity) => {
      activityCount += 1;
      const id = `activity-${activityCount}`;
      params.recorder.recordWireCall({
        method: "context.sendActivity",
        target: params.conversationId,
        payload: typeof activity === "string" ? { text: activity } : activity,
        result: { id },
      });
      return { id };
    },
    sendActivities: reject("sendActivities"),
    updateActivity: reject("updateActivity"),
    deleteActivity: reject("deleteActivity"),
    stream: params.stream,
  };
}

function createTraceRuntimeStub(
  recorder: WireRecorder,
  captureDispatcherOptions: (options: CapturedDispatcherOptions) => void,
): PluginRuntime {
  return {
    channel: {
      // Real text helpers: chunking behavior is part of the recorded lifecycle.
      text: {
        resolveChunkMode,
        chunkMarkdownTextWithMode,
        convertMarkdownTables,
        resolveMarkdownTableMode,
      },
      reply: {
        createReplyDispatcherWithTyping: (options: CapturedDispatcherOptions) => {
          captureDispatcherOptions(options);
          return {
            dispatcher: {},
            replyOptions: {},
            // Mirror core createReplyDispatcherWithTyping.markDispatchIdle: with
            // no typing controller bound it stops typing via the callbacks, which
            // ends the 8s keepalive loop and the 10min TTL timer.
            markDispatchIdle: () => {
              options.typingCallbacks?.onIdle?.();
            },
            markRunComplete: () => {},
          };
        },
        resolveHumanDelayConfig: () => undefined,
      },
    },
    system: {
      // Delivery-failure escalation is agent-visible choreography; record it so
      // goldens catch drift (none of the adopted scenarios should emit one).
      enqueueSystemEvent: (text: string, opts?: { contextKey?: string }) => {
        recorder.recordWireCall({
          method: "system.enqueueSystemEvent",
          payload: { text, contextKey: opts?.contextKey },
        });
      },
    },
  } as unknown as PluginRuntime;
}

type MSTeamsTraceCase = {
  golden: string;
  scenario: DeliveryTraceScenarioName;
  conversationType: "personal" | "channel";
  conversationId: string;
  streamWriteFault?: StreamWriteFault;
};

const MSTEAMS_TRACE_CASES: readonly MSTeamsTraceCase[] = [
  {
    // Native append-sink streaming in a DM: cumulative pipeline text becomes
    // delta emits; the AI-label chrome + feedback channelData merge into the
    // closing activity at finalize.
    golden: "streaming-happy-dm",
    scenario: "streaming-happy",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
  },
  {
    // Same script in a channel: native streaming is DM-only and typing is
    // unsupported for channel conversations, so everything batches as block
    // sends that flush at markDispatchIdle.
    golden: "block-fallback-channel",
    scenario: "streaming-happy",
    conversationType: "channel",
    conversationId: "19:channel-trace@thread.tacv2;messageid=1000",
  },
  {
    // User Stop: the second stream write throws StreamCancelledError. Terminal
    // state is canceled — no finalize chrome, no block redelivery, and typing
    // pulses are suppressed for the rest of the turn.
    golden: "cancel-via-write-error",
    scenario: "cancel-mid-stream",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
    streamWriteFault: { atWrite: 2, kind: "cancelled" },
  },
  {
    // Mid-stream non-cancel write failure latches streamFailed: the streamed
    // prefix stays visible AND the full reply re-delivers as blocks. A later
    // segment rewrites the stale stream buffer, then finalize attempts the
    // closing metadata write after fallback delivery. The duplication is the
    // contract (truncation is the worse outcome).
    golden: "stream-failure-redeliver-full",
    scenario: "streaming-happy",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
    streamWriteFault: { atWrite: 2, kind: "broken" },
  },
];

function setupMSTeamsTrace(recorder: WireRecorder, traceCase: MSTeamsTraceCase) {
  let captured: CapturedDispatcherOptions | undefined;
  setMSTeamsRuntime(
    createTraceRuntimeStub(recorder, (options) => {
      captured = options;
    }),
  );
  const stream = createRecordingStream(recorder, traceCase.streamWriteFault);
  const context = createRecordingTurnContext({
    recorder,
    conversationId: traceCase.conversationId,
    conversationType: traceCase.conversationType,
    stream,
  });
  const created = createMSTeamsReplyDispatcher({
    cfg: { channels: { msteams: {} } } as OpenClawConfig,
    agentId: "agent",
    sessionKey: "agent:msteams:trace",
    runtime: { error: () => {} } as never,
    log: { info: () => {}, error: () => {} },
    app: {} as never,
    appId: "app-trace",
    conversationRef: {
      activityId: "inbound-activity",
      user: { id: "29:trace-user", name: "Trace User" },
      agent: { id: "28:trace-bot", name: "OpenClaw" },
      conversation: {
        id: traceCase.conversationId,
        conversationType: traceCase.conversationType,
        tenantId: "tenant-trace",
      },
      tenantId: "tenant-trace",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    },
    context,
    // Both the DM policy and the channel default (requireMention=true) resolve
    // to "thread", which keeps sends on the live turn context.
    replyStyle: "thread",
    textLimit: 4000,
  });
  const options = captured;
  if (!options) {
    throw new Error("dispatcher options were not captured");
  }

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options.onReplyStart?.();
        break;
      case "partial":
        // Only present when the controller owns a native stream (DM); the
        // channel case has no onPartialReply and partials are dropped.
        created.replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await options.deliver({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        // Progress lines only render in streaming.mode=progress; with the
        // default partial mode this is a controller-side no-op.
        await created.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final":
        await options.deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        break;
      case "cancel":
        // No cancel event exists on msteams: cancellation is detected via the
        // armed StreamCancelledError write fault, so this step maps to nothing.
        break;
      case "idle":
        await created.markDispatchIdle();
        break;
      case "wire-fault":
        // The shared write-error fault vocabulary covers this shape, but a
        // scripted step records a new IN event and would change the committed
        // goldens; write-count arming at setup replays the same wire bytes.
        throw new Error("msteams trace scenarios arm stream write faults at setup instead");
    }
  };
}

describe("msteams delivery trace goldens", () => {
  for (const traceCase of MSTEAMS_TRACE_CASES) {
    it(`records ${traceCase.golden}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[traceCase.scenario],
        setup: (recorder) => setupMSTeamsTrace(recorder, traceCase),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${traceCase.golden}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
