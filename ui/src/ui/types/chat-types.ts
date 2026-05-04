/**
 * Chat message types for the UI layer.
 */

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
  | { kind: "stream"; key: string; text: string; startedAt: number }
  | { kind: "reading-indicator"; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
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
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
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
  };
};
