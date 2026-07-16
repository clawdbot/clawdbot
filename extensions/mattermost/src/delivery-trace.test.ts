// Mattermost delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Wires the real draft-stream path the monitor uses (createMattermostDraftStream,
// preview boundary controller, deliverMattermostReplyWithDraftPreview,
// deliverMattermostReplyPayload) against a recording MattermostClient, so OUT
// events are the raw REST calls (POST/PUT/DELETE /posts). The monitor's
// per-activity glue (partial dedupe, boundary rotation) is replicated inline in
// block-preview mode; the scripted steps stand in for the dispatcher callbacks.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, it, vi } from "vitest";
import { createMattermostPost, type MattermostClient } from "./mattermost/client.js";
import {
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./mattermost/draft-stream.js";
import { resolveMattermostReplyRootId } from "./mattermost/monitor-context.js";
import { deliverMattermostReplyWithDraftPreview } from "./mattermost/monitor-draft-delivery.js";
import { deliverMattermostReplyPayload } from "./mattermost/reply-delivery.js";

const CHANNEL_ID = "channel-trace";
const ROOT_ID = "root-trace";
const ACCOUNT_ID = "main";
// Matches the monitor's draft stream wiring (throttleMs: 1200).
const DRAFT_THROTTLE_MS = 1200;

const cfg = {} as OpenClawConfig;
const tableMode = resolveMarkdownTableMode({ cfg, channel: "mattermost" });
const chunkMode = resolveChunkMode(cfg, "mattermost", ACCOUNT_ID);
const textLimit = resolveTextChunkLimit(cfg, "mattermost", ACCOUNT_ID, { fallbackLimit: 4000 });

// deliverMattermostReplyPayload only touches channel.text helpers; bind the
// real implementations the plugin runtime would provide.
const core = {
  channel: {
    text: { convertMarkdownTables, resolveChunkMode, chunkMarkdownTextWithMode },
  },
} as unknown as PluginRuntime;

function createRecordingMattermostClient(recorder: WireRecorder): MattermostClient {
  let postCount = 0;
  const requestImpl = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET";
    const payload =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    if (method === "POST" && path === "/posts") {
      postCount += 1;
      const result = { id: `post-${postCount}` };
      recorder.recordWireCall({
        method: "POST /posts",
        target: typeof payload?.channel_id === "string" ? payload.channel_id : "",
        payload,
        result,
      });
      return result as T;
    }
    if (path.startsWith("/posts/")) {
      const postId = path.slice("/posts/".length);
      if (method === "DELETE") {
        recorder.recordWireCall({
          method: `DELETE ${path}`,
          target: postId,
          result: { status: "OK" },
        });
        return { status: "OK" } as T;
      }
      const result = { id: postId };
      recorder.recordWireCall({ method: `${method} ${path}`, target: postId, payload, result });
      return result as T;
    }
    throw new Error(`Unexpected Mattermost request: ${method} ${path}`);
  };
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "test-token",
    request: vi.fn(requestImpl) as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
}

function setupMattermostTrace(recorder: WireRecorder) {
  const client = createRecordingMattermostClient(recorder);
  const draftStream = createMattermostDraftStream({
    client,
    channelId: CHANNEL_ID,
    rootId: ROOT_ID,
    throttleMs: DRAFT_THROTTLE_MS,
    chunkText: (value) =>
      chunkMarkdownTextWithMode(convertMarkdownTables(value, tableMode), textLimit, chunkMode),
  });
  const previewBoundary = createMattermostDraftPreviewBoundaryController({
    enabled: true,
    forceNewMessage: async () => {
      await draftStream.forceNewMessage();
    },
  });
  const previewState = { finalizedViaPreviewPost: false };
  let lastPartialText = "";

  // Replicas of the monitor's inline final-text resolution glue
  // (extensions/mattermost/src/mattermost/monitor.ts deliver wiring).
  const resolveFinalDeliveryText = (text?: string) => {
    if (typeof text !== "string") {
      return undefined;
    }
    const resolution = draftStream.resolveFinalText(text);
    return resolution.kind === "already-delivered" ? "" : resolution.text;
  };
  const resolvePreviewFinalText = (text?: string) => {
    const deliveryText = resolveFinalDeliveryText(text);
    if (typeof deliveryText !== "string") {
      return undefined;
    }
    const formatted = convertMarkdownTables(deliveryText, tableMode);
    const chunks = chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return undefined;
    }
    const trimmed = chunks[0]?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (
      lastPartialText &&
      lastPartialText.startsWith(trimmed) &&
      trimmed.length < lastPartialText.length
    ) {
      return undefined;
    }
    return trimmed;
  };

  const deliverPayload = async (payloadToDeliver: ReplyPayload) => {
    const finalTextResolution =
      !payloadToDeliver.isError && typeof payloadToDeliver.text === "string"
        ? draftStream.resolveFinalText(payloadToDeliver.text)
        : undefined;
    const resolvedPayload = finalTextResolution
      ? {
          ...payloadToDeliver,
          text: finalTextResolution.kind === "already-delivered" ? "" : finalTextResolution.text,
        }
      : payloadToDeliver;
    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: resolvedPayload,
      to: `channel:${CHANNEL_ID}`,
      accountId: ACCOUNT_ID,
      agentId: "agent",
      replyToId: resolveMattermostReplyRootId({
        kind: "channel",
        threadRootId: ROOT_ID,
        replyToId: payloadToDeliver.replyToId,
      }),
      textLimit,
      tableMode,
      sendMessage: async (_to, text, opts) => {
        return await createMattermostPost(client, {
          channelId: CHANNEL_ID,
          message: text,
          rootId: opts.replyToId,
        });
      },
    });
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
      case "tool-progress":
      case "cancel":
        // Typing travels over the websocket (not the REST client), tool
        // progress is not adopted here, and an aborted run stops emitting
        // payloads; closeout happens on idle.
        break;
      case "partial": {
        const cleaned = step.text.trim();
        if (!cleaned || cleaned === lastPartialText) {
          break;
        }
        if (
          lastPartialText &&
          lastPartialText.startsWith(cleaned) &&
          cleaned.length < lastPartialText.length
        ) {
          break;
        }
        lastPartialText = cleaned;
        draftStream.updateAssistantText(cleaned);
        previewBoundary.noteUpdate();
        break;
      }
      case "block-final":
        // Block boundary = assistant message boundary: partial snapshots reset
        // and the block-mode preview rotates to a fresh post.
        lastPartialText = "";
        await previewBoundary.noteBoundary();
        break;
      case "final":
        // Final resolution may edit the confirmed preview post in place; join
        // outstanding boundary work first, like the monitor deliver wiring.
        await draftStream.settleBoundaries();
        await deliverMattermostReplyWithDraftPreview({
          payload: {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          info: { kind: "final" },
          kind: "channel",
          client,
          draftStream,
          effectiveReplyToId: ROOT_ID,
          resolvePreviewFinalText,
          previewState,
          logVerboseMessage: () => {},
          deliverPayload,
        });
        break;
      case "idle":
        // Mirrors the monitor's finally block: stop flushes the last pending
        // preview text and keeps the post.
        await draftStream.stop();
        break;
      case "wire-fault":
        throw new Error("mattermost trace scenarios do not script wire faults");
    }
  };
}

const MATTERMOST_TRACE_SCENARIOS: readonly DeliveryTraceScenarioName[] = [
  "streaming-happy",
  "final-only",
  "cancel-mid-stream",
];

describe("mattermost delivery trace goldens", () => {
  for (const scenarioName of MATTERMOST_TRACE_SCENARIOS) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[scenarioName],
        setup: setupMattermostTrace,
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
