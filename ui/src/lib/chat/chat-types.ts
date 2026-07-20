/**
 * Chat message types for the UI layer.
 */

import type { SenderIdentity } from "./sender-label.ts";

export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ChatQueueSkillWorkshopRevision = { proposalId: string; agentId?: string };

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  kind?: "queued" | "steered";
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
  sendState?:
    | "waiting-model"
    | "waiting-idle"
    | "executing-command"
    | "steering"
    | "sending"
    | "waiting-reconnect"
    | "unconfirmed"
    | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  sender?: SenderIdentity;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: "divider";
      key: string;
      label: string;
      metric?: string;
      description?: string;
      action?: { kind: "session-checkpoints"; label: string };
      timestamp: number;
    }
  | { kind: "stream"; key: string; text: string; startedAt: number; isStreaming: boolean }
  | { kind: "reading-indicator"; key: string; startedAt: number }
  | { kind: "question"; key: string; questionId: string; startedAt: number }
  | { kind: "plan"; key: string };

export type ChatStreamSegment = {
  text: string;
  ts: number;
  toolCallId?: string;
  itemId?: string;
};

export function streamSegmentHasItemId(segment: { itemId?: unknown }): boolean {
  return typeof segment.itemId === "string" && segment.itemId.trim().length > 0;
}

export function streamSegmentUsesAccumulatedText(segment: { itemId?: unknown }): boolean {
  return !streamSegmentHasItemId(segment);
}

export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  sender?: SenderIdentity;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
  turnSucceeded?: boolean;
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
        kind: "image" | "audio" | "video" | "document";
        label: string;
        mimeType?: string;
        isVoiceNote?: boolean;
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
