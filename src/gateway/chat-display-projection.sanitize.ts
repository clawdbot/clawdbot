import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { parseInboundMediaUri, buildInboundMediaUriFromPath } from "../media/media-reference.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import {
  isToolHistoryBlockType,
  isToolResultHistoryBlockType,
  messageHasToolResultShape,
  projectToolResultDetails,
} from "./chat-display-projection.canvas.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  isAssistantTextContentType,
  isProjectedSessionsSendForwardedMessage,
  shouldPreserveAssistantControlReplyText,
  truncateChatHistoryText,
} from "./chat-display-projection.helpers.js";
import {
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "./control-reply-text.js";
import {
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";

const MEDIA_PRIVATE_FIELDS = ["data", "blob", "path", "file", "filePath", "localPath"] as const;
const MEDIA_REFERENCE_FIELDS = ["url", "openUrl", "image_url", "audio_url", "video_url"] as const;
const MEDIA_FACT_PRIVATE_FIELDS = [
  "workspaceDir",
  ...MEDIA_PRIVATE_FIELDS.filter((field) => field !== "path"),
] as const;

function projectChatHistoryMediaReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const reference = value.trim();
  if (/^\/(?:api\/chat\/media\/outgoing|media|__openclaw__)\//u.test(reference)) {
    return reference.split(/[?#]/u, 1)[0];
  }
  try {
    if (/^media:/iu.test(reference)) {
      return parseInboundMediaUri(reference)?.normalizedSource;
    }
    const url = new URL(reference);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.username = url.password = url.search = url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function projectChatHistoryMediaBlock(entry: Record<string, unknown>, fact = false): boolean {
  if (!fact && (typeof entry.type !== "string" || !/^(?:image|audio|video)$/u.test(entry.type))) {
    return false;
  }
  const media = entry as typeof entry & { type: "image" | "audio" | "video" };
  const hasTopLevelPayload = typeof media.data === "string" || typeof media.blob === "string";
  const source = fact ? undefined : readRecord(media.source);
  const projectedSource = source ? { ...source } : undefined;
  const records: Record<string, unknown>[] = [media, ...(projectedSource ? [projectedSource] : [])];
  if (projectedSource) {
    media.source = projectedSource;
  }
  const privateFields = fact ? MEDIA_FACT_PRIVATE_FIELDS : MEDIA_PRIVATE_FIELDS;
  const referenceFields = fact ? (["path", "url"] as const) : MEDIA_REFERENCE_FIELDS;
  const sourceIsReference =
    !source &&
    (!fact ||
      typeof media.source !== "string" ||
      /^(?:[a-z][a-z0-9+.-]*:|~?[\\/])|[\\/]/iu.test(media.source));
  let encodedPayload: string | undefined;
  for (const record of records) {
    let omitted = false;
    const payload = typeof record.data === "string" ? record.data : record.blob;
    if (encodedPayload === undefined && typeof payload === "string") {
      encodedPayload = payload;
    }
    for (const field of privateFields) {
      if (!Object.hasOwn(record, field)) {
        continue;
      }
      delete record[field];
      omitted = true;
    }
    const recordReferences =
      record === media && sourceIsReference ? [...referenceFields, "source"] : referenceFields;
    for (const field of recordReferences) {
      if (!Object.hasOwn(record, field)) {
        continue;
      }
      // Managed inbound file paths persisted on media facts are host-local absolute
      // paths; rewrite them to canonical `media://inbound/<id>` URIs the UI loads through
      // the authenticated assistant-media route, instead of redacting the reference entirely.
      const inboundUri = fact ? buildInboundMediaUriFromPath(String(record[field])) : undefined;
      const projected = inboundUri ?? projectChatHistoryMediaReference(record[field]);
      record[field] = projected;
      if (projected === undefined) {
        delete record[field];
        omitted = true;
      }
    }
    if (!fact && omitted) {
      // Preserve shipped image/audio omission ownership; new video blocks mark both levels.
      if (record === media || media.type !== "image") {
        record.omitted = true;
      }
      if (record === media || media.type !== "audio") {
        media.omitted = true;
      }
    }
  }
  if (!fact && encodedPayload !== undefined) {
    (media.type === "audio" && !hasTopLevelPayload && projectedSource
      ? projectedSource
      : media
    ).bytes = estimateBase64DecodedBytes(encodedPayload);
  }
  return true;
}

function projectChatHistoryMediaFacts(value: unknown): unknown[] | undefined {
  return Array.isArray(value)
    ? value.map((fact) => {
        const projected = { ...readRecord(fact) };
        projectChatHistoryMediaBlock(projected, true);
        return projected;
      })
    : undefined;
}

export function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: { preserveExactToolPayload?: boolean; maxChars?: number },
): { block: unknown; changed: boolean; truncated: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false, truncated: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  // Display-cap truncation is a fact consumers need (to fetch the full row), so
  // it is tracked apart from `changed`, which also covers metadata stripping.
  let truncated = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  if (isToolResultHistoryBlockType(entry.type) && "details" in entry) {
    const projectedDetails = projectToolResultDetails(entry.details, maxChars);
    if (projectedDetails.details) {
      entry.details = projectedDetails.details;
    } else {
      delete entry.details;
    }
    changed = true;
    truncated ||= projectedDetails.truncated;
  }
  if (typeof entry.text === "string") {
    if (!preserveExactToolPayload) {
      const res = truncateChatHistoryText(entry.text, maxChars);
      entry.text = res.text;
      changed ||= res.truncated;
      truncated ||= res.truncated;
    }
  }
  if (typeof entry.content === "string") {
    if (!preserveExactToolPayload) {
      const res = truncateChatHistoryText(entry.content, maxChars);
      entry.content = res.text;
      changed ||= res.truncated;
      truncated ||= res.truncated;
    }
  }
  if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.partialJson, maxChars);
    entry.partialJson = res.text;
    changed ||= res.truncated;
    truncated ||= res.truncated;
  }
  if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.arguments, maxChars);
    entry.arguments = res.text;
    changed ||= res.truncated;
    truncated ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
    truncated ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  if ("openclawReasoningReplay" in entry) {
    delete entry.openclawReasoningReplay;
    changed = true;
  }
  const mediaChanged = projectChatHistoryMediaBlock(entry);
  changed ||= mediaChanged;
  return { block: changed ? entry : block, changed, truncated };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return entry.type === "text" && Boolean(parseAssistantTextSignature(entry)?.phase);
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (entry.type !== "text") {
      return true;
    }
    return parseAssistantTextSignature(entry)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function projectAssistantMixedToolContent(
  content: unknown[],
  maxChars: number,
): { content: unknown[]; changed: boolean } | null {
  const hasToolHistoryBlock = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
  if (!hasToolHistoryBlock) {
    return null;
  }

  let hasVisibleText = false;
  const projectedContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (!isAssistantTextContentType(entry.type)) {
      projectedContent.push(block);
      continue;
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      continue;
    }
    const truncated = truncateChatHistoryText(entry.text, maxChars);
    if (truncated.text.trim()) {
      projectedContent.push({ type: "text", text: truncated.text });
      hasVisibleText = true;
    }
  }

  // Mixed messages supply both the visible bubble and its reasoning/tool trace.
  // Keep structured siblings or a history reload loses activity shown while live.
  return hasVisibleText ? { content: projectedContent, changed: true } : null;
}

function sanitizeCost(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const value = asFiniteNumber(c[key]);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  const knownFields = [
    "input",
    "output",
    "total",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
  ];

  for (const k of knownFields) {
    const n = asFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function projectWorkspaceConflictDetails(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (entry.role !== "custom" || entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  const details = readRecord(entry.details);
  if (
    !details ||
    !Array.isArray(details.paths) ||
    details.paths.length === 0 ||
    !details.paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof details.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) ||
    (details.totalCount !== undefined &&
      (!Number.isSafeInteger(details.totalCount) ||
        (details.totalCount as number) < details.paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  } catch {
    return undefined;
  }
}

export function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;
  let truncated = false;
  if ("providerReplay" in entry) {
    delete entry.providerReplay;
    changed = true;
  }
  const openClawMeta = readRecord(entry["__openclaw"]);
  if (openClawMeta && ("upstreamUserText" in openClawMeta || "media" in openClawMeta)) {
    // Codex retains the decorated upstream prompt for transcript reconstruction.
    // It is not display data and can otherwise evict the visible row from history.
    const projectedMeta = { ...openClawMeta };
    delete projectedMeta.upstreamUserText;
    if ("media" in projectedMeta) {
      projectedMeta.media = projectChatHistoryMediaFacts(projectedMeta.media);
      if (projectedMeta.media === undefined) {
        delete projectedMeta.media;
      }
    }
    if (Object.keys(projectedMeta).length > 0) {
      entry["__openclaw"] = projectedMeta;
    } else {
      delete entry["__openclaw"];
    }
    changed = true;
  }
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    const conflictDetails = projectWorkspaceConflictDetails(entry);
    const toolResultDetails =
      !conflictDetails && messageHasToolResultShape(entry)
        ? projectToolResultDetails(entry.details, maxChars)
        : undefined;
    const projectedDetails = conflictDetails ?? toolResultDetails?.details;
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
    changed = true;
    truncated ||= toolResultDetails?.truncated === true;
  }

  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  const stripAssistantControlTokens =
    role === "assistant" && !shouldPreserveAssistantControlReplyText(entry);

  if (typeof entry.content === "string") {
    const controlStripped = stripAssistantControlTokens
      ? stripSuppressedControlReplyToken(entry.content)
      : entry.content;
    changed ||= controlStripped !== entry.content;
    if (preserveExactToolPayload) {
      entry.content = controlStripped;
    } else {
      const res = truncateChatHistoryText(controlStripped, maxChars);
      entry.content = res.text;
      changed ||= res.truncated;
      truncated ||= res.truncated;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => {
      const sanitized = sanitizeChatHistoryContentBlock(block, {
        preserveExactToolPayload,
        maxChars,
      });
      if (
        !stripAssistantControlTokens ||
        !sanitized.block ||
        typeof sanitized.block !== "object" ||
        Array.isArray(sanitized.block)
      ) {
        return sanitized;
      }
      const contentBlock = sanitized.block as { type?: unknown; text?: unknown };
      if (!isAssistantTextContentType(contentBlock.type) || typeof contentBlock.text !== "string") {
        return sanitized;
      }
      const text = stripSuppressedControlReplyToken(contentBlock.text);
      return text === contentBlock.text
        ? sanitized
        : { block: { ...contentBlock, text }, changed: true, truncated: sanitized.truncated };
    });
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
    truncated ||= updated.some((item) => item.truncated);
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const mixedToolContent = projectAssistantMixedToolContent(entry.content, maxChars);
      if (mixedToolContent) {
        entry.content = mixedToolContent.content;
        if (entry.phase === "commentary") {
          delete entry.phase;
        }
        changed = true;
      } else {
        const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
        if (sanitizedPhases.changed) {
          entry.content = sanitizedPhases.content;
          changed = true;
        }
      }
    }
  }

  if (typeof entry.text === "string") {
    const controlStripped = stripAssistantControlTokens
      ? stripSuppressedControlReplyToken(entry.text)
      : entry.text;
    changed ||= controlStripped !== entry.text;
    if (preserveExactToolPayload) {
      entry.text = controlStripped;
    } else {
      const res = truncateChatHistoryText(controlStripped, maxChars);
      entry.text = res.text;
      changed ||= res.truncated;
      truncated ||= res.truncated;
    }
  }

  if (truncated) {
    // Record the display cap where it is applied so any session.message or
    // chat.history consumer can tell a bounded preview from the full row and
    // fetch it via chat.message.get. An upstream "oversized" transcript
    // marker already explains the truncation; never overwrite its reason.
    const meta = readRecord(entry["__openclaw"]);
    entry["__openclaw"] = {
      ...meta,
      truncated: true,
      reason: typeof meta?.reason === "string" ? meta.reason : "display-cap",
    };
    changed = true;
  }

  return { message: changed ? entry : message, changed };
}

function hasAssistantMixedToolVisibleText(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolHistoryBlock = false;
  let hasText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (isToolHistoryBlockType(entry.type)) {
      hasToolHistoryBlock = true;
    }
    if (
      isAssistantTextContentType(entry.type) &&
      typeof entry.text === "string" &&
      entry.text.trim()
    ) {
      hasText = true;
    }
  }
  return hasToolHistoryBlock && hasText;
}

export function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown> & { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(entry)) {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return !hasAssistantMixedToolVisibleText(message);
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantDisplayableNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}
