/**
 * Publishes agent activity (streamed commentary + tool progress) into
 * ClickClack as durable `agent_commentary` / `agent_tool` message rows,
 * coalesced so one logical step becomes one row instead of a row per frame.
 *
 * Ported from the clickglass agent-bridge sidecar, adapted from gateway
 * websocket frames to the in-process `replyOptions.onItemEvent` seam:
 *
 * - Commentary/reasoning arrives as cumulative text snapshots per item id.
 *   Each segment becomes one durable row: POSTed when the segment starts
 *   streaming and PATCHed (debounced) as the snapshot grows, so prose
 *   interleaves chronologically with tool rows.
 * - Tool/step items can emit several frames (start/update/complete) for the
 *   same call, sometimes with lane-prefixed ids (`tool:X`, `command:X`).
 *   Normalize the prefix away to one key per call, POST one row on the first
 *   frame, and PATCH it when a later frame carries a strictly longer body.
 */
import { buildChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import type { ClickClackMessage, ClickClackMessageProvenance } from "./types.js";

/** Debounce window for PATCHing streaming commentary snapshots. */
const CLICKCLACK_COMMENTARY_FLUSH_MS = 700;

/** Item event payload shape delivered by `replyOptions.onItemEvent`. */
type ClickClackItemEventPayload = {
  itemId?: string;
  toolCallId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
  meta?: string;
};

/** Destination for durable activity rows (channel or DM conversation). */
type ClickClackActivityTarget = {
  channelId?: string;
  conversationId?: string;
};

/** Client subset needed by the publisher (satisfied by `createClickClackClient`). */
type ClickClackActivityClient = {
  createActivityMessage(params: {
    channelId?: string;
    conversationId?: string;
    body: string;
    kind: "agent_commentary" | "agent_tool";
    turnId?: string;
    provenance?: ClickClackMessageProvenance;
  }): Promise<ClickClackMessage>;
  updateMessageBody(messageId: string, body: string): Promise<ClickClackMessage>;
};

/** Item kinds rendered as agent_tool rows; everything else is commentary. */
const TOOL_ITEM_KINDS = new Set(["tool", "command", "command_output", "patch", "search", "api"]);

/** Item kinds that never become durable rows (ephemeral or plumbing lanes). */
const SKIPPED_ITEM_KINDS = new Set(["lifecycle"]);

/** Item kinds emitted as cumulative commentary snapshots. */
const STREAMING_COMMENTARY_ITEM_KINDS = new Set([
  "preamble",
  "commentary",
  "analysis",
  "thinking",
  "reasoning",
]);

/** Provider-specific reasoning lanes normalized into one ClickClack label. */
const THINKING_ITEM_KINDS = new Set(["analysis", "thinking", "reasoning"]);

function normalizedItemKind(payload: ClickClackItemEventPayload): string {
  return payload.kind?.trim().toLowerCase() ?? "";
}

function commentaryBody(payload: ClickClackItemEventPayload): string {
  const text =
    payload.progressText?.trim() || payload.summary?.trim() || payload.meta?.trim() || "";
  if (!text) {
    return "";
  }
  const kind = normalizedItemKind(payload);
  if (THINKING_ITEM_KINDS.has(kind)) {
    return `**Thinking**\n\n${text}`;
  }
  return text;
}

function activityBody(payload: ClickClackItemEventPayload): string {
  // Reuse the shared channel progress-line renderer so ClickClack rows show
  // the same tool name + command/argument detail as Discord/Slack/Telegram
  // progress lines instead of a bespoke format.
  const line = buildChannelProgressDraftLine({
    event: "item",
    itemId: payload.itemId,
    toolCallId: payload.toolCallId,
    itemKind: payload.kind,
    title: payload.title,
    name: payload.name,
    phase: payload.phase,
    status: payload.status,
    summary: payload.summary,
    progressText: payload.progressText,
    meta: payload.meta,
  })?.text?.trim();
  if (line) {
    return line;
  }
  const head = payload.name?.trim() || payload.title?.trim();
  const text = payload.progressText?.trim() || payload.summary?.trim();
  if (head && text) {
    return `**${head}**\n\n${text}`;
  }
  if (text) {
    return text;
  }
  if (head) {
    return head;
  }
  return payload.status?.trim() || payload.kind?.trim() || "";
}

type CommentarySegment = {
  messageId?: string;
  body: string;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type ToolRow = {
  messageId?: string;
  body: string;
  /** Body last sent to ClickClack; skips redundant PATCHes after late reads. */
  sentBody?: string;
};

/** Publisher wired into one agent turn via `replyOptions.onItemEvent`. */
export type ClickClackActivityPublisher = {
  onItemEvent: (payload: ClickClackItemEventPayload) => void;
  /**
   * Records the resolved model/thinking for this turn (from
   * `replyOptions.onModelSelected`); stamped onto subsequent activity rows.
   */
  setProvenance: (provenance: ClickClackMessageProvenance) => void;
  /** Flushes pending commentary and awaits all outstanding POST/PATCH work. */
  finalize: () => Promise<void>;
};

/**
 * Creates a per-turn activity publisher. Publishing is best-effort: transport
 * failures are reported through `onError` and never interrupt the reply turn.
 */
export function createClickClackActivityPublisher(params: {
  client: ClickClackActivityClient;
  target: ClickClackActivityTarget;
  turnId: string;
  flushMs?: number;
  onError?: (error: unknown) => void;
}): ClickClackActivityPublisher {
  const flushMs = params.flushMs ?? CLICKCLACK_COMMENTARY_FLUSH_MS;
  const commentaryByItem = new Map<string, CommentarySegment>();
  const toolRows = new Map<string, ToolRow>();
  let provenance: ClickClackMessageProvenance | undefined;
  // Single promise chain so POST/PATCH ordering matches frame arrival order.
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work).catch((error: unknown) => {
      params.onError?.(error);
    });
    return chain;
  };

  const postRow = (kind: "agent_commentary" | "agent_tool", body: string) =>
    params.client.createActivityMessage({
      channelId: params.target.channelId,
      conversationId: params.target.conversationId,
      body,
      kind,
      turnId: params.turnId,
      provenance,
    });

  const flushCommentary = (segmentKey: string): Promise<void> => {
    const segment = commentaryByItem.get(segmentKey);
    if (!segment) {
      return Promise.resolve();
    }
    if (segment.timer) {
      clearTimeout(segment.timer);
      segment.timer = undefined;
    }
    if (!segment.dirty || !segment.body.trim()) {
      return Promise.resolve();
    }
    segment.dirty = false;
    const body = segment.body;
    return enqueue(async () => {
      if (segment.messageId) {
        await params.client.updateMessageBody(segment.messageId, body);
        return;
      }
      const posted = await postRow("agent_commentary", body);
      segment.messageId = posted.id;
    });
  };

  const flushAllCommentary = (): Promise<void> => {
    const flushes = [...commentaryByItem.keys()].map((key) => flushCommentary(key));
    return Promise.all(flushes).then(() => undefined);
  };

  const handleCommentary = (payload: ClickClackItemEventPayload): void => {
    const body = commentaryBody(payload);
    if (!body.trim()) {
      return;
    }
    const key = payload.itemId?.trim() || "turn";
    let segment = commentaryByItem.get(key);
    if (!segment) {
      segment = { body: "", dirty: false };
      commentaryByItem.set(key, segment);
    }
    // Snapshots are cumulative per item; never shrink the row body on a
    // shorter (stale or whitespace-normalized) frame, and skip identical
    // snapshots entirely so out-of-order frames cannot queue redundant
    // PATCHes.
    if (body.length < segment.body.length || body === segment.body) {
      return;
    }
    segment.body = body;
    segment.dirty = true;
    if (!segment.timer) {
      segment.timer = setTimeout(() => {
        segment.timer = undefined;
        void flushCommentary(key);
      }, flushMs);
    }
  };

  const toolRowKey = (payload: ClickClackItemEventPayload): string => {
    // toolCallId is an opaque identifier: use it untouched when present.
    // itemId carries a lane/lifecycle prefix (`tool:X`, `command:X`) on some
    // frames and appears bare on others, so normalize only itemId to give
    // all frames of one call a shared key.
    const toolCallId = payload.toolCallId?.trim();
    if (toolCallId) {
      return toolCallId;
    }
    const itemId = payload.itemId?.trim() ?? "";
    return itemId.replace(/^(tool|command):/, "");
  };

  const handleDiscreteItem = (payload: ClickClackItemEventPayload): void => {
    const body = activityBody(payload);
    if (!body) {
      return;
    }
    const kind = TOOL_ITEM_KINDS.has(payload.kind?.trim().toLowerCase() ?? "")
      ? ("agent_tool" as const)
      : ("agent_commentary" as const);
    // Flush streaming prose first so the commentary row lands before the
    // step row it precedes chronologically.
    void flushAllCommentary();
    const key = `${kind}:${toolRowKey(payload)}`;
    const existing = toolRows.get(key);
    if (!existing || !toolRowKey(payload)) {
      const row: ToolRow = { body };
      if (toolRowKey(payload)) {
        toolRows.set(key, row);
      }
      void enqueue(async () => {
        // Late read is intentional: if the body was upgraded before this POST
        // ran, post the richer body directly and skip the follow-up PATCH.
        const posted = await postRow(kind, row.body);
        row.messageId = posted.id;
        row.sentBody = row.body;
      });
      return;
    }
    // Only upgrade the row when the new frame says strictly more (longer
    // body), so a bare lane echo like "read" never clobbers a summary.
    if (body.length <= existing.body.length) {
      return;
    }
    existing.body = body;
    void enqueue(async () => {
      if (existing.messageId && existing.body !== existing.sentBody) {
        await params.client.updateMessageBody(existing.messageId, existing.body);
        existing.sentBody = existing.body;
      }
    });
  };

  return {
    onItemEvent: (payload) => {
      const kind = normalizedItemKind(payload);
      if (STREAMING_COMMENTARY_ITEM_KINDS.has(kind)) {
        handleCommentary(payload);
        return;
      }
      if (SKIPPED_ITEM_KINDS.has(kind)) {
        return;
      }
      handleDiscreteItem(payload);
    },
    setProvenance: (next) => {
      provenance = next;
    },
    finalize: async () => {
      await flushAllCommentary();
      await chain;
    },
  };
}
