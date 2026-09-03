import type { WebClient } from "@slack/web-api";
// Slack delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the real dispatch wiring (dispatchPreparedSlackMessage → deliverSlackPayload
// → native stream / draft preview / preview finalize / deliverReplies → sendMessageSlack)
// with the core agent turn mocked at the channel-inbound dispatch seam:
// the scripted steps stand in for the reply dispatcher callbacks (typing, partials,
// tool progress, per-payload deliver). OUT events are the Slack Web API calls observed
// at a recording WebClient stand-in. Native streaming runs through the REAL
// @slack/web-api ChatStreamer so the SDK's buffering contract is captured as-is:
// previews may remain buffered below 256 chars, but finals flush before delivery
// settles, including when native rejection requires ordinary-message fallback.
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
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";
import { setSlackSessionStatus } from "./session-status.js";
import { markSlackStreamsStopped } from "./streaming.js";

type RecordedWireCall = {
  method: string;
  target?: string;
  payload?: unknown;
  result?: unknown;
};

type CapturedDispatcherOptions = {
  deliver: (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => Promise<unknown>;
  onError?: (err: unknown, info: { kind: string }) => Promise<void> | void;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  typingCallbacks?: {
    onReplyStart?: () => Promise<void>;
    onIdle?: () => void;
    onCleanup?: () => void;
  };
};

type CapturedReplyOptions = {
  suppressDefaultToolProgressMessages?: boolean;
  onPartialReply?: (payload: { text: string }) => Promise<void> | void;
  onToolStart?: (payload: {
    name: string;
    phase: "start" | "result";
    itemId?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
  }) => Promise<void> | void;
  onItemEvent?: (payload: {
    kind: string;
    itemId?: string;
    toolCallId?: string;
    phase?: string;
    status?: string;
    progressText?: string;
    name?: string;
  }) => Promise<void> | void;
};

type TurnCounts = Record<ReplyDispatchKind, number>;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

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

const traceRuntimeError = vi.fn();

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
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      traceState.turn = {
        options: {
          ...params.dispatcherOptions,
          deliver: params.delivery.deliver,
          onError: params.delivery.onError,
        } as CapturedDispatcherOptions,
        replyOptions: (params.replyOptions ?? {}) as CapturedReplyOptions,
      };
      traceState.turnStarted?.resolve();
      if (!traceState.turnOutcome) {
        throw new Error("trace turn outcome gate not initialized");
      }
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: await traceState.turnOutcome.promise,
      };
    },
  };
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
    createSlackReadClient: traceClient,
    createSlackWebClient: traceClient,
    createSlackWriteClient: traceClient,
    getSlackWriteClient: traceClient,
  };
});

import { dispatchPreparedSlackMessage } from "./monitor/message-handler/dispatch.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
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
});

const CHANNEL_ID = "C0TRACE";
const USER_ID = "U0TRACE";
const TEAM_ID = "T0TRACE";
// Matches the harness epoch (2026-01-01T00:00:00Z → 1767225600) so the inbound
// ts is plausible under the fake clock; the normalizer canonicalizes it anyway.
const INBOUND_TS = "1767225600.000100";

type SlackTraceScenarioName =
  | "streaming-happy-native"
  | "short-final-native-rejection"
  | "final-blocks-and-text"
  | "cancel-mid-stream"
  | "preview-edit-fallback"
  | "progress-compact-commentary"
  | "progress-session-card"
  | "progress-native-unified"
  | "native-prose-then-exec-failed"
  | "preview-exec-failed-then-prose";

const NATIVE_SCENARIOS = new Set<SlackTraceScenarioName>([
  "streaming-happy-native",
  "short-final-native-rejection",
  "final-blocks-and-text",
  "native-prose-then-exec-failed",
]);

const NATIVE_PROGRESS_NARRATION =
  "I’m checking the native Slack stream before applying the focused patch.";
const NATIVE_PROGRESS_NARRATION_UPDATED = `${NATIVE_PROGRESS_NARRATION} I’m applying it now.`;

// Long enough that the second stream append pushes the SDK buffer past
// buffer_size (256), forcing the first visible flush via chat.startStream.
const NATIVE_FINAL_TEXT =
  "Deploy status: build is green. Canary rollout reached 50 percent with the error " +
  "budget intact, latency holding steady at the p95 target, and no alerts firing " +
  "across the fleet. Rolling out to production now and watching the dashboards for " +
  "the next fifteen minutes before closing out the change.";

// Below the SDK's buffer threshold: final delivery must explicitly flush it.
const SHORT_FINAL_TEXT = "All checks passed. Ship it.";

const PREVIEW_PARTIAL_ONE = "Compiling the changelog";
const PREVIEW_PARTIAL_TWO = "Compiling the changelog for 2026.1.0.";
const PREVIEW_FINAL_TEXT = "Compiling the changelog for 2026.1.0.\n\nDone: 12 entries.";
const EXEC_FAILED_TRACE = "⚠️ 🛠️ Exec failed: ";
const EXEC_FAILED_PROSE = "The directory is missing.";
const COMPACT_COMMENTARY_TEXT = "Checking the current Slack behavior.";
const COMPACT_COMMENTARY_TEXT_UPDATED =
  "Checking the current Slack behavior and preparing the focused fix.";
const COMPACT_FINAL_TEXT = "Compact Slack progress is ready.";

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
  "short-final-native-rejection": [
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
  // chat.update, and the final promotes the draft in place. Custom identity uses
  // a disposable app-authored draft plus a separate customized final instead.
  "preview-edit-fallback": [
    { kind: "reply-start" },
    { kind: "partial", text: PREVIEW_PARTIAL_ONE },
    { kind: "advance", ms: 300 },
    { kind: "partial", text: PREVIEW_PARTIAL_TWO },
    { kind: "advance", ms: 1100 },
    { kind: "final", text: PREVIEW_FINAL_TEXT },
    { kind: "idle" },
  ],
  "progress-compact-commentary": [
    { kind: "reply-start" },
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT },
    { kind: "advance", ms: 2000 },
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT_UPDATED },
    { kind: "advance", ms: 2000 },
    { kind: "final", text: COMPACT_FINAL_TEXT },
    { kind: "idle" },
  ],
  "progress-session-card": [
    { kind: "reply-start" },
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "final", text: "The session card is complete." },
    { kind: "idle" },
  ],
  "progress-native-unified": [
    { kind: "reply-start" },
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
    { kind: "tool-progress", name: "write", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION_UPDATED },
    { kind: "tool-progress", name: "write", phase: "result" },
    { kind: "final", text: "The unified native Slack turn is complete." },
    { kind: "idle" },
  ],
  "native-prose-then-exec-failed": [
    { kind: "reply-start" },
    { kind: "final", text: EXEC_FAILED_PROSE },
    { kind: "final", text: EXEC_FAILED_TRACE },
    { kind: "idle" },
  ],
  "preview-exec-failed-then-prose": [
    { kind: "reply-start" },
    { kind: "partial", text: EXEC_FAILED_TRACE },
    { kind: "advance", ms: 1100 },
    { kind: "partial", text: EXEC_FAILED_PROSE },
    { kind: "advance", ms: 1100 },
    { kind: "final", text: EXEC_FAILED_PROSE },
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
    apiCall: async (method: string, args: Record<string, unknown>) => {
      record({
        method,
        target: `${asWireString(args.channel_id)}/${asWireString(args.thread_ts)}`,
        payload: stripToken(args),
        result: { ok: true },
      });
      return { ok: true };
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
  const compactProgress = scenario === "progress-compact-commentary";
  const progressCard = scenario === "progress-session-card";
  const nativeProgress = scenario === "progress-native-unified";
  const cfg = {
    channels: { slack: { enabled: true } },
    ...(progressCard || nativeProgress
      ? {
          gateway: {
            publicOrigin: "https://team.openclaw.ai",
            controlUi: { basePath: "/openclaw" },
          },
        }
      : {}),
  } as OpenClawConfig;
  const client = traceState.client;
  if (!client) {
    throw new Error("trace Slack client not initialized");
  }
  const prepared = {
    ctx: {
      cfg,
      runtime: { log: () => {}, error: traceRuntimeError },
      botToken: "xoxb-trace",
      app: { client },
      teamId: TEAM_ID,
      botUserId: "UBOT",
      botId: "BBOT",
      textLimit: 4000,
      typingReaction: "",
      allowFrom: [],
      setSlackSessionStatus: (p: {
        channelId: string;
        threadTs?: string;
        status: "processing" | "active" | "suspended";
        title?: string;
      }) => setSlackSessionStatus({ ...p, client: client as unknown as WebClient }),
    },
    account: {
      accountId: "default",
      config: compactProgress
        ? {
            streaming: {
              mode: "progress",
              nativeTransport: true,
              progress: {
                style: "compact",
                nativeTaskCards: true,
                label: false,
                commentary: true,
                toolProgress: false,
              },
            },
          }
        : progressCard
          ? // Native task cards are the progress default; this scenario owns the
            // Block Kit opt-out path.
            { streaming: { progress: { nativeTaskCards: false } } }
          : nativeProgress
            ? // Empty progress config on purpose: proves the shipped default.
              { streaming: { mode: "progress" } }
            : {
                streaming: {
                  mode: "partial",
                  nativeTransport: NATIVE_SCENARIOS.has(scenario),
                },
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
  traceRuntimeError.mockClear();
  traceState.counts = { tool: 0, block: 0, final: 0 };
  traceState.turn = null;
  traceState.turnStarted = createDeferred<void>();
  traceState.turnOutcome = createDeferred<{ queuedFinal: boolean; counts: TurnCounts }>();
  // Rejected native final delivery must complete ordinary-message fallback
  // before the dispatcher settles the final payload.
  traceState.rejectStartStreamCode =
    scenario === "short-final-native-rejection"
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
    const transformed = turn.options.transformReplyPayload
      ? turn.options.transformReplyPayload(payload)
      : payload;
    if (!transformed) {
      return;
    }
    try {
      await turn.options.deliver(transformed, { kind });
      traceState.counts[kind] += 1;
    } catch (err) {
      // Mirrors the reply dispatcher: failed deliveries report onError and are
      // not counted as dispatched.
      await turn.options.onError?.(err, { kind });
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
        if (scenario === "progress-compact-commentary") {
          await turn.replyOptions.onItemEvent?.({
            kind: "preamble",
            itemId: "preamble-1",
            progressText: step.text,
          });
        } else if (scenario === "progress-native-unified") {
          await turn.replyOptions.onItemEvent?.({
            kind: "preamble",
            itemId: "preamble-1",
            progressText: step.text,
          });
          await deliver({ text: step.text, isCommentary: true }, "block");
        } else {
          await turn.replyOptions.onPartialReply?.({ text: step.text });
        }
        break;
      case "tool-progress":
        if (scenario === "progress-native-unified") {
          if (step.phase === "start") {
            await turn.replyOptions.onToolStart?.({
              name: step.name,
              phase: step.phase,
              itemId: "write-1",
              toolCallId: "write-call-1",
              args: { path: "src/native-card.ts", content: "const unified = true;\n" },
            });
          } else {
            await turn.replyOptions.onItemEvent?.({
              kind: "tool",
              itemId: "write-1",
              toolCallId: "write-call-1",
              phase: "end",
              status: "completed",
              progressText: "src/native-card.ts",
              name: step.name,
            });
          }
        } else {
          await turn.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        }
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

function collectSlackWireTexts(events: readonly TraceEvent[]): string[] {
  const texts: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      texts.push(value);
    }
  };
  for (const event of events) {
    if (event.dir !== "out" || !event.data || typeof event.data !== "object") {
      continue;
    }
    const payload = (event.data as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as Record<string, unknown>;
    pushText(record.text);
    pushText(record.markdown_text);
    if (Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        if (chunk && typeof chunk === "object") {
          pushText((chunk as { text?: unknown }).text);
        }
      }
    }
  }
  return texts;
}

function buildSlackDeliveryProofVerdict(params: {
  scenario: SlackTraceScenarioName;
  events: readonly TraceEvent[];
  headSha: string;
}): Record<string, unknown> {
  const wireTexts = collectSlackWireTexts(params.events);
  return {
    kind: "mock-gateway",
    liveSlack: false,
    harness: "extensions/slack/src/delivery-trace.test.ts",
    channel: "slack",
    scenario: params.scenario,
    headSha: params.headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "recording WebClient",
      provider: "scripted agent turn",
      delivery: "real dispatchPreparedSlackMessage + ChatStreamer/draft preview",
    },
    inboundPayloads: params.events
      .filter((event) => event.dir === "in" && (event.kind === "final" || event.kind === "partial"))
      .map((event) => event.data),
    deliveredWireTexts: wireTexts,
    execFailedDelivered: wireTexts.some((text) => text.includes("Exec failed")),
    proseDelivered: wireTexts.some((text) => text.includes(EXEC_FAILED_PROSE)),
    outMethods: params.events.filter((event) => event.dir === "out").map((event) => event.kind),
  };
}

describe("slack delivery trace goldens", () => {
  const headSha = process.env.OPENCLAW_DELIVERY_PROOF_SHA ?? "";
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
      const wireTexts = collectSlackWireTexts(events);
      expect(wireTexts.join("\n")).not.toMatch(/Exec failed/i);
      if (
        scenarioName === "native-prose-then-exec-failed" ||
        scenarioName === "preview-exec-failed-then-prose"
      ) {
        expect(wireTexts.some((text) => text.includes(EXEC_FAILED_PROSE))).toBe(true);
        if (process.env.OPENCLAW_DELIVERY_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify(buildSlackDeliveryProofVerdict({ scenario: scenarioName, events, headSha }), null, 2)}\n`,
          );
        }
      }
    });
  }

  it("discards a Slack-stopped native stream without a duplicate final or stop request", async () => {
    let streamTs: string | undefined;
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: "slack-stopped-native-stream",
        steps: [
          { kind: "reply-start" },
          { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
          { kind: "tool-progress", name: "write", phase: "start" },
          // The progress compositor emits its initial card at 1500ms.
          { kind: "advance", ms: 2000 },
          { kind: "cancel" },
          { kind: "final", text: "Late answer that must not be posted" },
          { kind: "idle" },
        ],
      },
      setup: async (recorder) => {
        const handleStep = await setupSlackTrace(
          {
            recordWireCall: (call) => {
              if (call.method === "chat.startStream") {
                streamTs = (call.result as { ts?: string })?.ts;
              }
              recorder.recordWireCall(call);
            },
          },
          "progress-native-unified",
        );
        return async (step) => {
          if (step.kind === "cancel") {
            expect(streamTs).toBeDefined();
            markSlackStreamsStopped(traceState.client as unknown as WebClient, CHANNEL_ID, [
              streamTs!,
            ]);
          }
          await handleStep(step);
        };
      },
      normalize: createSlackTsNormalizer(),
    });
    const outMethods = events.filter((event) => event.dir === "out").map((event) => event.kind);
    expect(outMethods).toContain("chat.startStream");
    expect(outMethods).not.toContain("chat.stopStream");
    expect(outMethods).not.toContain("chat.postMessage");
    expect(collectSlackWireTexts(events).join("\n")).not.toContain("Late answer");
    expect(traceRuntimeError).not.toHaveBeenCalled();
  });

  it("removes a progress card detached by a later human message", async () => {
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: "progress-session-card-detached",
        steps: [
          { kind: "reply-start" },
          { kind: "tool-progress", name: "read", phase: "start" },
          { kind: "advance", ms: 2000 },
          { kind: "partial", text: "Writing the implementation" },
          { kind: "advance", ms: 2000 },
          { kind: "final", text: "The replacement session card is complete." },
          { kind: "idle" },
        ],
      },
      setup: async (recorder) => {
        const dispatch = await setupSlackTrace(recorder, "progress-session-card");
        return async (step) => {
          if (step.kind === "partial") {
            traceState.tsCounter += 1;
            noteSlackDraftConversationMessage({
              accountId: "default",
              channelId: CHANNEL_ID,
              threadTs: INBOUND_TS,
              messageTs: `1767225601.${String(traceState.tsCounter).padStart(6, "0")}`,
              userId: "U_SECOND",
              botUserId: "UBOT",
            });
            // A changed authored status moves progress below the human message;
            // ordinary tool activity intentionally leaves the summary unchanged.
            await traceState.turn?.replyOptions.onItemEvent?.({
              kind: "preamble",
              itemId: "preamble-1",
              progressText: step.text,
            });
            return;
          }
          await dispatch(step);
        };
      },
      normalize: createSlackTsNormalizer(),
    });

    const workingPosts = events.filter(
      (event) =>
        event.kind === "chat.postMessage" &&
        Array.isArray(
          (event.data as { payload?: { blocks?: unknown } } | undefined)?.payload?.blocks,
        ),
    );
    expect(workingPosts).toHaveLength(2);
    const firstCardId = (workingPosts[0]?.data as { result?: { ts?: string } } | undefined)?.result
      ?.ts;
    const secondCardId = (workingPosts[1]?.data as { result?: { ts?: string } } | undefined)?.result
      ?.ts;
    expect(firstCardId).toBeTruthy();
    expect(secondCardId).toBeTruthy();
    expect(
      events.some(
        (event) =>
          event.kind === "chat.delete" &&
          (event.data as { target?: string } | undefined)?.target === firstCardId,
      ),
    ).toBe(true);
    const completedCard = events.find(
      (event) =>
        event.kind === "chat.update" &&
        (event.data as { target?: string } | undefined)?.target === secondCardId,
    );
    expect(completedCard?.data).toMatchObject({
      payload: {
        blocks: expect.arrayContaining([
          {
            type: "section",
            text: { type: "mrkdwn", text: "Completed: *Writing the implementation*" },
          },
          {
            type: "actions",
            elements: expect.arrayContaining([
              expect.objectContaining({ action_id: "openclaw:session_link" }),
            ]),
          },
        ]),
      },
    });
  });
});
