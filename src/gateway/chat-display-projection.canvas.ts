import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractCanvasFromDetails, extractCanvasFromText } from "../chat/canvas-render.js";
import { truncateChatHistoryText } from "./chat-display-projection.helpers.js";

const MAX_TOOL_APPROVAL_REVIEWS = 16;
const TOOL_APPROVAL_REVIEW_STATUSES = new Set([
  "in_progress",
  "approved",
  "denied",
  "timed_out",
  "aborted",
]);

function boundedReviewText(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? truncateUtf16Safe(text, maxChars) : undefined;
}

function projectToolApprovalReview(value: unknown): Record<string, unknown> | undefined {
  const review = readRecord(value);
  const id = boundedReviewText(review?.id, 256);
  const label = boundedReviewText(review?.label, 80);
  const status = boundedReviewText(review?.status, 32);
  if (!id || !label || !status || !TOOL_APPROVAL_REVIEW_STATUSES.has(status)) {
    return undefined;
  }
  const riskLevel = boundedReviewText(review?.riskLevel, 40);
  const userAuthorization = boundedReviewText(review?.userAuthorization, 40);
  const rationale = boundedReviewText(review?.rationale, 2_000);
  return {
    id,
    label,
    status,
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

/** Return true for known tool-call/tool-result block type spellings in transcripts. */
export function isToolHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "toolresult" ||
    normalized === "tool_result"
  );
}

export function isToolResultHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return normalized === "toolresult" || normalized === "tool_result";
}

export function projectToolResultDetails(
  details: unknown,
  maxChars: number,
): { details: Record<string, unknown> | undefined; truncated: boolean } {
  const record = readRecord(details);
  if (!record) {
    return { details: undefined, truncated: false };
  }
  const projected: Record<string, unknown> = {};
  // The diff is the one display-capped field here; surface the fact so the
  // message-level marker covers capped tool-result details too.
  let truncated = false;
  for (const key of ["changed", "created"] as const) {
    if (typeof record[key] === "boolean") {
      projected[key] = record[key];
    }
  }
  if (typeof record.diff === "string" && record.diff.trim()) {
    const diff = truncateChatHistoryText(record.diff, maxChars);
    projected.diff = diff.text;
    truncated = diff.truncated;
  }
  if (Array.isArray(record.approvalReviews)) {
    const reviews = record.approvalReviews
      .slice(-MAX_TOOL_APPROVAL_REVIEWS)
      .flatMap((review) => projectToolApprovalReview(review) ?? []);
    if (reviews.length > 0) {
      projected.approvalReviews = reviews;
    }
  }
  const reviewOutcome = record.approvalReviewOutcome;
  if (reviewOutcome === "approved" || reviewOutcome === "denied" || reviewOutcome === "reviewing") {
    projected.approvalReviewOutcome = reviewOutcome;
  }
  const preview = extractCanvasFromDetails(record);
  if (preview?.mcpApp && preview.viewId) {
    projected.mcpAppPreview = {
      kind: "canvas",
      view: {
        id: preview.viewId,
        ...(preview.url ? { url: preview.url } : {}),
        ...(preview.title ? { title: preview.title } : {}),
      },
      presentation: {
        target: "assistant_message",
        ...(preview.title ? { title: preview.title } : {}),
        ...(preview.preferredHeight ? { preferred_height: preview.preferredHeight } : {}),
        ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
      },
      mcpApp: preview.mcpApp,
    };
  }
  return { details: Object.keys(projected).length > 0 ? projected : undefined, truncated };
}

export function messageHasToolResultShape(message: Record<string, unknown>): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role === "toolresult" || role === "tool_result" || role === "tool" || role === "function") {
    return true;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (
    content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        isToolResultHistoryBlockType((block as { type?: unknown }).type),
    )
  ) {
    return true;
  }
  const hasToolCallBlock = content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      isToolHistoryBlockType((block as { type?: unknown }).type) &&
      !isToolResultHistoryBlockType((block as { type?: unknown }).type),
  );
  const hasToolId =
    typeof message.toolCallId === "string" ||
    typeof message.tool_call_id === "string" ||
    typeof message.toolUseId === "string" ||
    typeof message.tool_use_id === "string";
  const hasToolName = typeof message.toolName === "string" || typeof message.tool_name === "string";
  return hasToolId && hasToolName && !hasToolCallBlock;
}

export function extractChatHistoryBlockText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const textParts = entry.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typed = block as { text?: unknown };
      return typeof typed.text === "string" ? typed.text : undefined;
    })
    .filter((value): value is string => typeof value === "string");
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractChatHistoryCanvasPreview(message: Record<string, unknown>) {
  const direct = extractCanvasFromDetails(message.details);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  for (const block of message.content) {
    const preview = extractCanvasFromDetails(readRecord(block)?.details);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

function appendCanvasBlockToAssistantHistoryMessage(params: {
  message: unknown;
  preview: ReturnType<typeof extractCanvasFromText>;
  rawText: string | null;
}): unknown {
  const preview = params.preview;
  if (!preview || !params.message || typeof params.message !== "object") {
    return params.message;
  }
  const entry = params.message as Record<string, unknown>;
  const baseContent = Array.isArray(entry.content)
    ? [...entry.content]
    : typeof entry.content === "string"
      ? [{ type: "text", text: entry.content }]
      : typeof entry.text === "string"
        ? [{ type: "text", text: entry.text }]
        : [];
  const alreadyPresent = baseContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as { type?: unknown; preview?: unknown };
    return (
      typed.type === "canvas" &&
      typed.preview &&
      typeof typed.preview === "object" &&
      (((typed.preview as { viewId?: unknown }).viewId &&
        (typed.preview as { viewId?: unknown }).viewId === preview.viewId) ||
        ((typed.preview as { url?: unknown }).url &&
          (typed.preview as { url?: unknown }).url === preview.url))
    );
  });
  if (!alreadyPresent) {
    baseContent.push({
      type: "canvas",
      preview,
      rawText: params.rawText,
    });
  }
  return {
    ...entry,
    content: baseContent,
  };
}

function messageContainsToolHistoryContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string"
  ) {
    return true;
  }
  if (!Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
}

export function augmentChatHistoryWithCanvasBlocks(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  const next = [...messages];
  let changed = false;
  let lastAssistantIndex = -1;
  let lastRenderableAssistantIndex = -1;
  const pending: Array<{
    preview: NonNullable<ReturnType<typeof extractCanvasFromText>>;
    rawText: string | null;
  }> = [];
  for (let index = 0; index < next.length; index++) {
    const message = next[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role === "assistant") {
      lastAssistantIndex = index;
      if (!messageContainsToolHistoryContent(entry)) {
        lastRenderableAssistantIndex = index;
        if (pending.length > 0) {
          let target = next[index];
          for (const item of pending) {
            target = appendCanvasBlockToAssistantHistoryMessage({
              message: target,
              preview: item.preview,
              rawText: item.rawText,
            });
          }
          next[index] = target;
          pending.length = 0;
          changed = true;
        }
      }
      continue;
    }
    if (!messageContainsToolHistoryContent(entry)) {
      continue;
    }
    const toolName =
      typeof entry.toolName === "string"
        ? entry.toolName
        : typeof entry.tool_name === "string"
          ? entry.tool_name
          : undefined;
    const text = extractChatHistoryBlockText(entry);
    const detailsPreview = extractChatHistoryCanvasPreview(entry);
    const preview = detailsPreview ?? extractCanvasFromText(text, toolName);
    if (!preview) {
      continue;
    }
    pending.push({
      preview,
      rawText: detailsPreview ? null : (text ?? null),
    });
  }
  if (pending.length > 0) {
    const targetIndex =
      lastRenderableAssistantIndex >= 0 ? lastRenderableAssistantIndex : lastAssistantIndex;
    if (targetIndex >= 0) {
      let target = next[targetIndex];
      for (const item of pending) {
        target = appendCanvasBlockToAssistantHistoryMessage({
          message: target,
          preview: item.preview,
          rawText: item.rawText,
        });
      }
      next[targetIndex] = target;
      changed = true;
    }
  }
  return changed ? next : messages;
}
