import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ControlModelConversationSnapshot } from "../../../../packages/gateway-client/src/model/conversation.js";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import {
  persistedMessageEntryId,
  rawMessageTimestamp,
  resolveMessageToolUseId,
} from "./chat-thread-items.ts";

export type ControlModelArtifactPreview = {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
  toolCallId: string;
  messageId?: string;
  toolName?: string;
};

type ControlModelArtifact = ControlModelConversationSnapshot["artifacts"][number];

function artifactSourceMessageId(message: unknown): string | null {
  const raw = asRecord(message);
  const surfaceId =
    typeof raw?.messageId === "string" && raw.messageId.trim()
      ? raw.messageId
      : typeof raw?.id === "string"
        ? raw.id
        : undefined;
  return readSessionMessageIdentity(message, { messageId: surfaceId })?.id ?? null;
}

function artifactPreview(
  artifact: ControlModelArtifact,
): ControlModelArtifactPreview["preview"] | null {
  const view =
    artifact.views.find((candidate) => candidate.recommended && candidate.fallback) ??
    artifact.views.find((candidate) => candidate.fallback);
  const fallback = view?.fallback;
  if (artifact.state !== "ready" || !fallback) {
    return null;
  }
  if (fallback.kind === "canvas") {
    return {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      url: fallback.url,
      ...(fallback.viewId ? { viewId: fallback.viewId } : {}),
      sandbox: fallback.sandbox,
    };
  }
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId: fallback.viewId,
    mcpApp: {
      viewId: fallback.viewId,
      ...(fallback.uiResourceUri ? { uiResourceUri: fallback.uiResourceUri } : {}),
      ...(artifact.source.toolName ? { toolName: artifact.source.toolName } : {}),
      ...(artifact.source.toolCallId ? { toolCallId: artifact.source.toolCallId } : {}),
    },
  };
}

export function controlModelArtifactPreviews(
  artifacts: ControlModelConversationSnapshot["artifacts"],
  messages: readonly unknown[],
): ControlModelArtifactPreview[] {
  return artifacts.flatMap((artifact) => {
    const preview = artifactPreview(artifact);
    const toolCallId = artifact.source.toolCallId;
    if (!preview || !toolCallId) {
      return [];
    }
    const sourceMessage = artifact.source.messageId
      ? messages.find((message) => artifactSourceMessageId(message) === artifact.source.messageId)
      : undefined;
    const text =
      artifact.structuredContent === undefined ? null : JSON.stringify(artifact.structuredContent);
    return [
      {
        preview,
        text,
        timestamp: sourceMessage === undefined ? null : rawMessageTimestamp(sourceMessage),
        toolCallId,
        ...(artifact.source.messageId ? { messageId: artifact.source.messageId } : {}),
        ...(artifact.source.toolName ? { toolName: artifact.source.toolName } : {}),
      },
    ];
  });
}

export function controlModelArtifactSourceKeys(message: unknown): string[] {
  const raw = asRecord(message);
  const messageId = persistedMessageEntryId(message);
  const toolCallId = raw ? resolveMessageToolUseId(raw) : undefined;
  const keys: string[] = [];
  if (messageId && toolCallId) {
    keys.push(JSON.stringify(["message-tool", messageId, toolCallId]));
  }
  if (toolCallId) {
    keys.push(JSON.stringify(["tool", toolCallId]));
  }
  if (messageId && !toolCallId) {
    keys.push(JSON.stringify(["message", messageId]));
  }
  return keys;
}

export function mergeControlModelArtifactPreview(
  raw: ControlModelArtifactPreview["preview"],
  projected: ControlModelArtifactPreview["preview"],
): ControlModelArtifactPreview["preview"] {
  return {
    ...raw,
    ...projected,
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.preferredHeight ? { preferredHeight: raw.preferredHeight } : {}),
  };
}
