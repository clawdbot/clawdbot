import type { Attachment, SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeToolResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCopilotAssistantUsage, type CopilotUsageSnapshot } from "./usage-bridge.js";

export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type AssistantUsageSnapshot = CopilotUsageSnapshot;

export interface AttemptTranscriptJournalProjection {
  markReplayIncomplete(): void;
  recordAssistantProjectionGap(): void;
  recordAssistant(input: {
    eventId: string;
    message: AssistantMessage;
    replayIncomplete?: boolean;
    toolCallIds: string[];
  }): void;
  recordSdkUser(input: {
    autopilotContinuation: boolean;
    eventId: string;
    message: Extract<AgentMessage, { role: "user" }>;
    replayIncomplete?: boolean;
  }): void;
  recordToolResult(input: {
    eventId: string;
    message: Extract<AgentMessage, { role: "toolResult" }>;
    replayIncomplete?: boolean;
  }): void;
}

export function buildAssistantMessage(params: {
  assistantTexts: string[];
  event?: Extract<SessionEvent, { type: "assistant.message" }>;
  modelRef: { api?: string; id: string; provider: string };
  now: () => number;
  reasoningText?: string;
  usage?: AssistantUsageSnapshot;
}): AssistantMessage | undefined {
  const event = params.event;
  const text = event ? event.data.content || params.assistantTexts.at(-1) || "" : "";
  const reasoningText = event?.data.reasoningText ?? params.reasoningText;
  const toolRequests = event?.data.toolRequests ?? [];
  if (!text && !reasoningText && toolRequests.length === 0) {
    return undefined;
  }
  const content: AssistantMessage["content"] = [];
  if (reasoningText) {
    content.push({ thinking: reasoningText, type: "thinking" });
  }
  if (text) {
    content.push({ text, type: "text" });
  }
  for (const request of toolRequests) {
    content.push({
      arguments: request.arguments ?? {},
      id: request.toolCallId,
      name: request.name,
      type: "toolCall",
    });
  }
  return {
    api: params.modelRef.api ?? "openai-responses",
    content,
    model: event?.data.model ?? params.modelRef.id,
    provider: params.modelRef.provider,
    role: "assistant",
    stopReason: toolRequests.length > 0 ? "toolUse" : "stop",
    timestamp: params.now(),
    usage: buildCopilotAssistantUsage({
      fallbackOutputTokens: event?.data.outputTokens,
      usage: params.usage,
    }),
  };
}

export function resolveAssistantUsage(
  event: Extract<SessionEvent, { type: "assistant.message" }> | undefined,
  latest: AssistantUsageSnapshot | undefined,
  byApiCallId: Map<string, AssistantUsageSnapshot>,
): AssistantUsageSnapshot | undefined {
  const apiCallId = readString(event?.data.apiCallId);
  return apiCallId ? (byApiCallId.get(apiCallId) ?? latest) : latest;
}

export function resolveEventTimestamp(timestamp: string, now: () => number): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : now();
}

export function hasOwnKeys(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

export function projectSdkUserMetadata(
  attachments: Attachment[] | undefined,
  source: string | undefined,
): Record<string, unknown> | undefined {
  const summaries = (attachments ?? []).map((attachment) => {
    const {
      data: _data,
      payload: _payload,
      text: _text,
      ...summary
    } = attachment as Attachment & {
      data?: unknown;
      payload?: unknown;
      text?: unknown;
    };
    return summary;
  });
  const media = (attachments ?? []).flatMap<{
    contentType?: string;
    kind?: string;
    path: string;
  }>((attachment) => {
    if (attachment.type === "file") {
      return [{ path: attachment.path, contentType: attachment.mimeType }];
    }
    return attachment.type === "selection" ? [{ path: attachment.filePath, kind: "document" }] : [];
  });
  if (!source && summaries.length === 0) {
    return undefined;
  }
  return {
    ...(source ? { copilotSource: source } : {}),
    ...(summaries.length > 0 ? { copilotAttachments: summaries } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

export function projectToolResultDetails(
  data: Extract<SessionEvent, { type: "tool.execution_complete" }>["data"],
): unknown {
  const result = data.result;
  const sanitizedContents = result?.contents
    ? (sanitizeToolResult({ content: result.contents }) as { content?: unknown }).content
    : undefined;
  const binaryResultsForLlm = result?.binaryResultsForLlm?.map((entry) => {
    const { data: _data, ...descriptor } = entry as typeof entry & { data?: unknown };
    return descriptor;
  });
  const citableSources = result?.citableSources?.map((source) =>
    Object.assign({}, source, { content: sanitizeToolDetailText(source.content) }),
  );
  return sanitizeToolResult({
    ...(result?.detailedContent
      ? { content: [{ type: "text", text: result.detailedContent }] }
      : {}),
    ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(sanitizedContents ? { contents: sanitizedContents } : {}),
    ...(binaryResultsForLlm?.length ? { binaryResultsForLlm } : {}),
    ...(citableSources?.length ? { citableSources } : {}),
    ...(data.mcpMeta || result?.mcpMeta ? { mcpMeta: data.mcpMeta ?? result?.mcpMeta } : {}),
  });
}

export function sanitizeToolDetailText(text: string): string {
  const sanitized = sanitizeToolResult({ content: [{ type: "text", text }] }) as {
    content?: Array<{ text?: unknown }>;
  };
  const value = sanitized.content?.[0]?.text;
  return typeof value === "string" ? value : "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
