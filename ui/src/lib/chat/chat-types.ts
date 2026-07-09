/**
 * Chat message types for the UI layer.
 */

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
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  sendState?: "waiting-model" | "sending" | "waiting-reconnect" | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  skillWorkshopRevision?: ChatQueueSkillWorkshopRevision;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: "divider";
      key: string;
      label: string;
      description?: string;
      action?: { kind: "session-checkpoints"; label: string };
      timestamp: number;
    }
  | { kind: "stream"; key: string; text: string; startedAt: number; isStreaming: boolean }
  | { kind: "reading-indicator"; key: string };

export const CHAT_HISTORY_RENDER_LIMIT = 100;
export const CHAT_HISTORY_RENDER_CHAR_BUDGET = 240_000;

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
  isError?: boolean;
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
  };
};
