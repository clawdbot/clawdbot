/**
 * Chat message types for the UI layer.
 */

import type { MediaKind } from "@openclaw/media-core/constants";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { toolIcons } from "../../components/icons-tools.ts";
import type { SenderIdentity } from "./sender-label.ts";

export type BrowserAnnotationAttachment = {
  modelContext: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  inspectedElement: boolean;
};

export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
  /** UI-local context that must remain coupled to its annotated screenshot. */
  browserAnnotation?: BrowserAnnotationAttachment;
};

export type ChatComposerDraftRetry = {
  expectedDraftRevision: number;
  draftRevision: number;
};

export type ChatComposerMemoryFallback = {
  message: string;
  attachments: ChatAttachment[];
  storageFailed: boolean;
  draftRetry?: ChatComposerDraftRetry;
  sequence: number;
};

export type ChatGuardianNotice = {
  key: string;
  runId: string;
  timestamp: number;
  kind: "approved" | "denied" | "reviewing" | "strict-review-required" | "warning";
  source?: "system";
  command?: string;
  riskLevel?: string;
  rationale?: string;
  message?: string;
};

export type ToolApprovalReview = {
  id: string;
  label: string;
  status: "in_progress" | "approved" | "denied" | "timed_out" | "aborted";
  riskLevel?: string;
  userAuthorization?: string;
  rationale?: string;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  /** Operator-owned queue position; absent means "wherever arrival put it". */
  orderKey?: number;
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
  /** Transcript id of the replied-to message; Gateway hydrates reply context. */
  replyToId?: string;
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  /** One-send override retained with the durable row for reconnect and retry. */
  queueMode?: QueueMode;
  sendState?:
    | "waiting-model"
    | "waiting-idle"
    | "executing-command"
    | "sending"
    | "waiting-reconnect"
    | "unconfirmed"
    | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  sender?: SenderIdentity;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: "notice";
      key: string;
      text: string;
      timestamp: number;
      icon?: keyof typeof toolIcons;
      label?: string;
      startsTurn?: true;
      boundaryId?: string;
      tone?: "danger";
      /** Collapse the body behind a disclosure; the label line stays visible. */
      collapsedBody?: true;
    }
  | {
      kind: "divider";
      key: string;
      label: string;
      icon?: keyof typeof toolIcons;
      metric?: string;
      description?: string;
      action?: { kind: "session-checkpoints"; label: string };
      timestamp: number;
    }
  | {
      kind: "stream";
      key: string;
      text: string;
      startedAt: number;
      isStreaming: boolean;
      runId?: string;
      boundaryId?: string;
    }
  | {
      kind: "reading-indicator";
      key: string;
      startedAt: number;
      runId?: string;
      boundaryId?: string;
    }
  | { kind: "question"; key: string; questionId: string; startedAt: number };

export type ChatStreamSegment = {
  text: string;
  ts: number;
  runId?: string;
  /** Persisted user send that causally precedes this transient output. */
  afterBoundaryRunId?: string;
  /** Persisted user send that causally follows this transient output. */
  boundaryRunId?: string;
  /** Ordering-only boundary with no renderable assistant text. */
  boundaryMarker?: true;
  /** Hidden durable replacement; cumulative text still owns the prefix baseline. */
  persisted?: true;
  toolCallId?: string;
  itemId?: string;
};

export function streamSegmentHasItemId(segment: { itemId?: unknown }): boolean {
  return typeof segment.itemId === "string" && segment.itemId.trim().length > 0;
}

export function streamSegmentUsesAccumulatedText(segment: {
  itemId?: unknown;
  boundaryMarker?: unknown;
}): boolean {
  return segment.boundaryMarker !== true && !streamSegmentHasItemId(segment);
}

/** Advance the accumulated-text tracker only when the segment genuinely
    extends it. A standalone (itemId-less) preamble whose text is not part of
    the cumulative run text must not become the prefix baseline: the next
    cumulative snapshot would fail the startsWith check and re-render every
    earlier segment's text. */
export function advanceAccumulatedStreamText(
  previousText: string | null,
  text: string,
): string | null {
  if (!text.trim()) {
    return previousText;
  }
  return previousText === null || text.startsWith(previousText) ? text : previousText;
}

export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}

export function accumulatedStreamText(
  segments: readonly ChatStreamSegment[],
  normalize: (text: string) => string = (text) => text,
): string | null {
  let accumulated: string | null = null;
  for (const segment of segments) {
    if (streamSegmentUsesAccumulatedText(segment)) {
      accumulated = advanceAccumulatedStreamText(accumulated, normalize(segment.text));
    }
  }
  return accumulated;
}

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  sender?: SenderIdentity;
  replyToSender?: SenderIdentity;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
  runId?: string;
};

/** Content item types in a normalized message */
export type MessageContentItem =
  | {
      type: "text" | "tool_call" | "tool_result";
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: "attachment";
      attachment: {
        url: string;
        kind: Exclude<MediaKind, "sticker" | "unknown">;
        label: string;
        mimeType?: string;
        isVoiceNote?: boolean;
        artifactId?: string;
        playback?: "native" | "transcode";
        sizeBytes?: number;
        durationMs?: number;
        width?: number;
        height?: number;
      };
    }
  | {
      type: "canvas";
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  sender?: SenderIdentity;
  audioAsVoice?: boolean;
  replyPreview?: { text: string; senderLabel?: string | null };
  replyTarget?:
    | {
        kind: "current";
      }
    | {
        kind: "id";
        id: string;
      }
    | null;
};

/** Tool card representation for inline tool call/result rendering */
export type ToolCard = {
  id: string;
  callId?: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  /** Structured tool result details (e.g. the edit tool's precomputed diff). */
  details?: unknown;
  /** Monotonic edit counts while a live tool call is still receiving input. */
  liveDiffStat?: { added: number; removed: number };
  /** Producer-reported process exit code, when the result supplies one. */
  exitCode?: number;
  isError?: boolean;
  /** True when the card comes from the live tool stream of the current run. */
  live?: boolean;
  /** True once a result landed, including historical results with empty output. */
  completed?: boolean;
  messageId?: string;
  preview?: {
    kind: "canvas";
    surface: "assistant_message";
    render: "url";
    title?: string;
    preferredHeight?: number;
    url?: string;
    viewId?: string;
    className?: string;
    style?: string;
    sandbox?: "strict" | "scripts";
    boardWidgetName?: string;
    mcpApp?: {
      viewId: string;
      serverName?: string;
      toolName?: string;
      uiResourceUri?: string;
      toolCallId?: string;
      originSessionKey?: string;
    };
  };
};

export type ToolCardOutcome = "running" | "succeeded" | "failed" | "unknown";
