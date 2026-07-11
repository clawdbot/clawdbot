// Slack delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the real dispatch wiring (dispatchPreparedSlackMessage → deliverSlackPayload
// → native stream / draft preview / preview finalize / deliverReplies → sendMessageSlack)
// with the core agent turn mocked at the dispatchReplyWithBufferedBlockDispatcher seam:
// the scripted steps stand in for the reply dispatcher callbacks (typing, partials,
// tool progress, per-payload deliver). OUT events are the Slack Web API calls observed
// at a recording WebClient stand-in. Native streaming runs through the REAL
// @slack/web-api ChatStreamer so the SDK's buffered-ack contract is captured as-is:
// append() returns null and issues NO network call until its local buffer crosses
// buffer_size (256 chars), and stop() can be the first network call for short replies.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import {
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceStep,
  type TraceEvent,
  type TraceNormalizer,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";

type RecordedWireCall = {
  method: string;
  target?: string;
  payload?: unknown;
  result?: unknown;
};

type CapturedDispatcherOptions = {
  deliver: (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => Promise<unknown>;
  onError?: (err: unknown, info: { kind: string }) => void;
  typingCallbacks?: {
    onReplyStart?: () => Promise<void>;
    onIdle?: () => void;
    onCleanup?: () => void;
  };
};

type CapturedReplyOptions = {
  suppressDefaultToolProgressMessages?: boolean;
  onPartialReply?: (payload: { text: string }) => Promise<void> | void;
  onToolStart?: (payload: { name: string; phase: "start" | "result" }) => Promise<void> | void;
};

type TurnCounts = Record<ReplyDispatchKind, number>;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type SlackTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  client: Record<string, unknown> | null;
  turn: { options: CapturedDispatcherOptions; replyOptions: CapturedReplyOptions } | null;
  turnStarted: Deferred<void> | null;
  turnOutcome: Deferred<{ queuedFinal: boolean; counts: TurnCounts }> | null;
  dispatchDone: Promise<void> | null;
  counts: TurnCounts;
  tsCounter: number;
  /** Scripted benign rejection for the next chat.startStream call (scenario-owned). */
  rejectStartStreamCode: string | undefined;
};

const traceState = vi.hoisted(
  (): SlackTraceState => ({
    recordWireCall: () => {},
    client: null,
    turn: null,
    turnStarted: null,
    turnOutcome: null,
    dispatchDone: null,
    counts: { tool: 0, block: 0, final: 0 },
    tsCounter: 0,
    rejectStartStreamCode: undefined,
  }),
);

// Replace only the core agent turn. Everything downstream of the captured
// deliver/typing/replyOptions wiring (dedupe, thread plan, native stream ladder,
// draft preview, preview finalize, deliverReplies chunking, sendMessageSlack)
// stays the real production code.
vi.mock("./monitor/reply.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor/reply.runtime.js")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: async (params: {
      dispatcherOptions: unknown;
      replyOptions?: unknown;
    }) => {
      traceState.turn = {
        options: params.dispatcherOptions as CapturedDispatcherOptions,
        replyOptions: (params.replyOptions ?? {}) as CapturedReplyOptions,
      };
      traceState.turnStarted?.resolve();
      if (!traceState.turnOutcome) {
        throw new Error("trace turn outcome gate not initialized");
      }
      return await traceState.turnOutcome.promise;
    },
  };
});

// Session-store recording is not wire behavior; keep the turn hermetic.
vi.mock("./monitor/conversation.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor/conversation.runtime.js")>();
  return { ...actual, recordInboundSession: async () => {} };
});

// send.ts/actions.ts build their own WebClient from tokens; route every client
// resolution to the scenario's recording client so all wire calls are captured.
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  const traceClient = () => {
    if (!traceState.client) {
      throw new Error("trace Slack client not initialized");
    }
    return traceState.client as never;
  };
  return {
    ...actual,
    createSlackWebClient: traceClient,
    createSlackWriteClient: traceClient,
    getSlackWriteClient: traceClient,
  };
});

import {
  dispatchPreparedSlackMessage,
  resetSlackStreamRecipientTeamCacheForTests,
} from "./monitor/message-handler/dispatch.js";

afterAll(() => {
  vi.doUnmock("./monitor/reply.runtime.js");
  vi.doUnmock("./monitor/conversation.runtime.js");
  vi.doUnmock("./client.js");
  vi.resetModules();
});

afterEach(async () => {
  // Unblock a failed run's pending turn so its dispatch promise settles instead
  // of leaking a forever-pending await into later tests.
  traceState.turnOutcome?.resolve({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  await traceState.dispatchDone?.catch(() => {});
  traceState.client = null;
  traceState.turn = null;
  traceState.turnStarted = null;
  traceState.turnOutcome = null;
  traceState.dispatchDone = null;
  traceState.rejectStartStreamCode = undefined;
  // The recipient-team cache is module-global; without a reset the users.info
  // lookup would only appear in the first recorded scenario.
  resetSlackStreamRecipientTeamCacheForTests();
});

const CHANNEL_ID = "C0TRACE";
const USER_ID = "U0TRACE";
const TEAM_ID = "T0TRACE";
// Matches the harness epoch (2026-01-01T00:00:00Z → 1767225600) so the inbound
// ts is plausible under the fake clock; the normalizer canonicalizes it anyway.
const INBOUND_TS = "1767225600.000100";

type SlackTraceScenarioName =
  | "streaming-happy-native"
  | "stream-stop-first-network-call"
  | "final-blocks-and-text"
  | "cancel-mid-stream"
  | "preview-edit-fallback";

const NATIVE_SCENARIOS = new Set<SlackTraceScenarioName>([
  "streaming-happy-native",
  "stream-stop-first-network-call",
  "final-blocks-and-text",
]);

// Long enough that the second stream append pushes the SDK buffer past
// buffer_size (256), forcing the first visible flush via chat.startStream.
const NATIVE_FINAL_TEXT =
  "Deploy status: build is green. Canary rollout reached 50 percent with the error " +
  "budget intact, latency holding steady at the p95 target, and no alerts firing " +
  "across the fleet. Rolling out to production now and watching the dashboards for " +
  "the next fifteen minutes before closing out the change.";

// Short enough that every append stays inside the SDK's local buffer, so the
// finalize stop() is the first Slack streaming network call of the turn.
const SHORT_FINAL_TEXT = "All checks passed. Ship it.";

const PREVIEW_PARTIAL_ONE = "Compiling the changelog";
const PREVIEW_PARTIAL_TWO = "Compiling the changelog for 2026.1.0.";
const PREVIEW_FINAL_TEXT = "Compiling the changelog for 2026.1.0.\n\nDone: 12 entries.";

const BLOCKS_FINAL_TEXT = "Release 2026.1.0 is ready to ship.";
// Portable presentation actions; slack renders them as Block Kit and must
// synthesize accessible fallback text because blocks hide top-level text.
const BLOCKS_FINAL_PRESENTATION = {
  blocks: [
    {
      type: "buttons",
      buttons: [
        { label: "Approve release", action: { type: "callback", value: "approve-release" } },
        { label: "Release notes", url: "https://docs.openclaw.ai/release" },
      ],
    },
  ],
};

// Slack-specific scenario scripts; the runner only consumes `steps` and the
// name (outside the shared scenario library) keys the golden filename.
const slackTraceScenarios: Record<SlackTraceScenarioName, readonly DeliveryTraceStep[]> = {
  "streaming-happy-native": [
    { kind: "reply-start" },
    // Native streaming has no partial preview (onPartialReply is undefined);
    // the partial is recorded as IN-only script context.
    { kind: "partial", text: "Deploy status:" },
    { kind: "advance", ms: 300 },
    // Default tool progress messages flow as tool-kind payloads under native
    // streaming; short text stays inside the SDK buffer (accepted, not visible).
    { kind: "tool-progress", name: "deploy_checks", phase: "start" },
    { kind: "advance", ms: 300 },
    { kind: "final", text: NATIVE_FINAL_TEXT },
    { kind: "idle" },
  ],
  "stream-stop-first-network-call": [
    { kind: "reply-start" },
    { kind: "partial", text: "All checks passed." },
    { kind: "advance", ms: 300 },
    { kind: "final", text: SHORT_FINAL_TEXT },
    { kind: "idle" },
  ],
  "final-blocks-and-text": [
    { kind: "reply-start" },
    { kind: "final", text: BLOCKS_FINAL_TEXT },
    { kind: "idle" },
  ],
  "cancel-mid-stream": [
    { kind: "reply-start" },
    { kind: "partial", text: "Working on the fix" },
    { kind: "advance", ms: 300 },
    { kind: "partial", text: "Working on the fix: patching now." },
    // Past the draft throttle (1000ms) so the second preview edit lands
    // before the run is aborted.
    { kind: "advance", ms: 1100 },
    { kind: "cancel" },
    { kind: "idle" },
  ],
  // Edit-preview tier: native transport ineligible → draft post + throttled
  // chat.update, and the final promotes the draft in place. The custom-identity
  // flavor of this tier is structurally unreachable: dispatch.ts disables the
  // draft stream whenever a custom identity is set because chat.update cannot
  // preserve custom authorship (identity turns instead deliver one final
  // chat.postMessage), so no golden exists for it.
  "preview-edit-fallback": [
    { kind: "reply-start" },
    { kind: "partial", text: PREVIEW_PARTIAL_ONE },
    { kind: "advance", ms: 300 },
    { kind: "partial", text: PREVIEW_PARTIAL_TWO },
    { kind: "advance", ms: 1100 },
    { kind: "final", text: PREVIEW_FINAL_TEXT },
    { kind: "idle" },
  ],
};

/** Canonicalizes Slack `sec.micro` timestamps to `ts#N` in first-seen order. */
function createSlackTsNormalizer(): TraceNormalizer {
  const seen = new Map<string, string>();
  const canonicalize = (value: string) =>
    value.replace(/\b\d{10}\.\d{6}\b/g, (ts) => {
      let mapped = seen.get(ts);
      if (!mapped) {
        mapped = `ts#${seen.size + 1}`;
        seen.set(ts, mapped);
      }
      return mapped;
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return canonicalize(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return value;
  };
  return (event: TraceEvent) =>
    event.data === undefined ? event : { ...event, data: walk(event.data) };
}

function nextSlackTs(): string {
  traceState.tsCounter += 1;
  return `1767225601.${String(traceState.tsCounter).padStart(6, "0")}`;
}

/** Wire args are untyped records; targets only ever carry string ids. */
function asWireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Drop credential-bearing fields so tokens can never reach committed goldens. */
function stripToken(args: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = args;
  return rest;
}

function createRecordingSlackClient(): Record<string, unknown> {
  const record = (call: RecordedWireCall) => {
    traceState.recordWireCall(call);
  };
  const unexpected = (method: string) => async () => {
    throw new Error(`unexpected Slack wire call: ${method}`);
  };
  const client: Record<string, unknown> = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        const ts = nextSlackTs();
        record({
          method: "chat.postMessage",
          target: asWireString(args.channel),
          payload: stripToken(args),
          result: { ts },
        });
        return {
          ok: true,
          channel: args.channel,
          ts,
          message: { ts, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
        };
      },
      update: async (args: Record<string, unknown>) => {
        record({
          method: "chat.update",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, channel: args.channel, ts: args.ts };
      },
      delete: async (args: Record<string, unknown>) => {
        record({
          method: "chat.delete",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true };
      },
      startStream: async (args: Record<string, unknown>) => {
        const rejectCode = traceState.rejectStartStreamCode;
        if (rejectCode) {
          traceState.rejectStartStreamCode = undefined;
          record({
            method: "chat.startStream",
            target: asWireString(args.channel),
            payload: stripToken(args),
            result: { ok: false, error: rejectCode },
          });
          const err = new Error(`An API error occurred: ${rejectCode}`);
          (err as Error & { data?: unknown }).data = { ok: false, error: rejectCode };
          throw err;
        }
        const ts = nextSlackTs();
        record({
          method: "chat.startStream",
          target: asWireString(args.channel),
          payload: stripToken(args),
          result: { ts },
        });
        return { ok: true, ts };
      },
      appendStream: async (args: Record<string, unknown>) => {
        record({
          method: "chat.appendStream",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, ts: args.ts };
      },
      stopStream: async (args: Record<string, unknown>) => {
        record({
          method: "chat.stopStream",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, ts: args.ts };
      },
    },
    users: {
      info: async (args: Record<string, unknown>) => {
        record({
          method: "users.info",
          target: asWireString(args.user),
          payload: stripToken(args),
          result: { team_id: TEAM_ID },
        });
        return { ok: true, user: { team_id: TEAM_ID } };
      },
    },
    assistant: {
      threads: {
        setStatus: async (args: Record<string, unknown>) => {
          record({
            method: "assistant.threads.setStatus",
            target: `${asWireString(args.channel_id)}/${asWireString(args.thread_ts)}`,
            payload: stripToken(args),
            result: { ok: true },
          });
          return { ok: true };
        },
      },
    },
    conversations: { open: unexpected("conversations.open") },
    reactions: { add: unexpected("reactions.add"), remove: unexpected("reactions.remove") },
  };
  // Mirror WebClient.chatStream: the REAL SDK ChatStreamer runs against this
  // recording client, so its local buffering decides when wire calls happen.
  client.chatStream = (args: unknown) =>
    new ChatStreamer(client as never, { debug: () => {} } as never, args as never, {});
  return client;
}

function createPreparedTraceMessage(scenario: SlackTraceScenarioName): PreparedSlackMessage {
  const cfg = { channels: { slack: { enabled: true } } } as OpenClawConfig;
  const client = traceState.client;
  if (!client) {
    throw new Error("trace Slack client not initialized");
  }
  const setStatus = (
    client as {
      assistant: {
        threads: { setStatus: (args: Record<string, unknown>) => Promise<unknown> };
      };
    }
  ).assistant.threads.setStatus;
  const prepared = {
    ctx: {
      cfg,
      runtime: { log: () => {}, error: () => {} },
      botToken: "xoxb-trace",
      app: { client },
      teamId: TEAM_ID,
      botUserId: "UBOT",
      botId: "BBOT",
      textLimit: 4000,
      typingReaction: "",
      removeAckAfterReply: false,
      allowFrom: [],
      // Mirrors the monitor's setSlackThreadStatus wiring
      // (extensions/slack/src/monitor/context.ts): typing travels over
      // assistant.threads.setStatus and is part of the recorded lifecycle.
      setSlackThreadStatus: async (p: {
        channelId: string;
        threadTs?: string;
        status: string;
        loadingMessages?: string[];
      }) => {
        if (!p.threadTs) {
          return;
        }
        await setStatus({
          channel_id: p.channelId,
          thread_ts: p.threadTs,
          status: p.status,
          ...(p.loadingMessages?.length
            ? { loading_messages: p.loadingMessages.slice(0, 10) }
            : {}),
        });
      },
    },
    account: {
      accountId: "default",
      config: {
        streaming: { mode: "partial", nativeTransport: NATIVE_SCENARIOS.has(scenario) },
      },
    },
    message: {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: USER_ID,
      ts: INBOUND_TS,
      event_ts: INBOUND_TS,
      text: "trace inbound",
    },
    route: {
      agentId: "trace-agent",
      accountId: "default",
      sessionKey: "slack:channel:c0trace",
      mainSessionKey: "main",
      lastRoutePolicy: "session",
    },
    channelConfig: null,
    replyTarget: `channel:${CHANNEL_ID}`,
    ctxPayload: { SessionKey: "slack:channel:c0trace", ChatType: "channel" },
    turn: { storePath: "/unused/slack-trace-sessions.json", record: {} },
    replyToMode: "all",
    requireMention: true,
    isDirectMessage: false,
    isRoomish: true,
    historyKey: "slack:trace",
    preview: "",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  };
  return prepared as unknown as PreparedSlackMessage;
}

async function setupSlackTrace(
  recorder: { recordWireCall: (call: RecordedWireCall) => void },
  scenario: SlackTraceScenarioName,
) {
  traceState.recordWireCall = recorder.recordWireCall;
  traceState.tsCounter = 0;
  traceState.counts = { tool: 0, block: 0, final: 0 };
  traceState.turn = null;
  traceState.turnStarted = createDeferred<void>();
  traceState.turnOutcome = createDeferred<{ queuedFinal: boolean; counts: TurnCounts }>();
  // stop() rejections with a benign finalize code while text is still buffered
  // must fall back to the durable full-text path (streaming.ts contract).
  traceState.rejectStartStreamCode =
    scenario === "stream-stop-first-network-call"
      ? "method_not_supported_for_channel_type"
      : undefined;
  traceState.client = createRecordingSlackClient();

  const dispatchDone = dispatchPreparedSlackMessage(createPreparedTraceMessage(scenario));
  traceState.dispatchDone = dispatchDone;
  await traceState.turnStarted.promise;
  const turn = traceState.turn as SlackTraceState["turn"];
  if (!turn) {
    throw new Error("trace turn wiring was not captured");
  }

  const deliver = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    try {
      await turn.options.deliver(payload, { kind });
      traceState.counts[kind] += 1;
    } catch (err) {
      // Mirrors the reply dispatcher: failed deliveries report onError and are
      // not counted as dispatched.
      turn.options.onError?.(err, { kind });
    }
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await turn.options.typingCallbacks?.onReplyStart?.();
        break;
      case "partial":
        // Present only on the draft-preview tier; native streaming leaves
        // onPartialReply undefined and partials stay IN-only script context.
        await turn.replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "tool-progress":
        await turn.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        // The mocked core dispatcher owns default tool progress messages; when
        // dispatch did not suppress them it would deliver a tool-kind payload,
        // so the script forwards a deterministic stand-in text.
        if (turn.replyOptions.suppressDefaultToolProgressMessages !== true) {
          await deliver({ text: `Using tool: ${step.name} (${step.phase})` }, "tool");
        }
        break;
      case "final":
        await deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
            ...(scenario === "final-blocks-and-text"
              ? { presentation: BLOCKS_FINAL_PRESENTATION }
              : {}),
          } as ReplyPayload,
          "final",
        );
        break;
      case "cancel":
        // An aborted run stops emitting payloads; closeout happens on idle.
        break;
      case "idle": {
        turn.options.typingCallbacks?.onIdle?.();
        turn.options.typingCallbacks?.onCleanup?.();
        // Let the fire-and-forget typing stop record before post-turn finalize,
        // matching the production settle-then-finalize order.
        await vi.advanceTimersByTimeAsync(0);
        traceState.turnOutcome?.resolve({
          queuedFinal: traceState.counts.final > 0,
          counts: { ...traceState.counts },
        });
        await traceState.dispatchDone;
        break;
      }
      case "block-final":
        // Native streaming turns run with disableBlockStreaming=true, so the
        // dispatcher never emits block-kind payloads on this wiring.
        throw new Error("slack trace scenarios do not script block-final steps");
      case "wire-fault":
        throw new Error("slack trace scenarios script wire faults via the recording client");
    }
  };
}

describe("slack delivery trace goldens", () => {
  for (const scenarioName of Object.keys(slackTraceScenarios) as SlackTraceScenarioName[]) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: { name: scenarioName, steps: slackTraceScenarios[scenarioName] },
        setup: (recorder) => setupSlackTrace(recorder, scenarioName),
        normalize: createSlackTsNormalizer(),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
