import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
  stripInterSessionPromptPrefixForDisplay,
} from "../sessions/input-provenance.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { extractChatHistoryBlockText } from "./chat-display-projection.canvas.js";
import {
  asRoleContentMessage,
  extractProjectedText,
  hasAssistantNonTextContent,
  hasTranscriptMediaFacts,
  isEmptyTextOnlyContent,
  isProjectedSessionsSendForwardedMessage,
  isSessionsSendInterSessionUserMessage,
  type RoleContentMessage,
} from "./chat-display-projection.helpers.js";

function digestTtsSupplementText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function readTtsSupplementMarker(
  message: Record<string, unknown>,
): { textSha256?: string; spokenText?: string } | undefined {
  const marker = message.openclawTtsSupplement;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return undefined;
  }
  const entry = marker as { textSha256?: unknown; spokenText?: unknown };
  const textSha256 =
    typeof entry.textSha256 === "string" && entry.textSha256.trim()
      ? entry.textSha256.trim()
      : undefined;
  const spokenText =
    typeof entry.spokenText === "string" && entry.spokenText.trim()
      ? entry.spokenText.trim()
      : undefined;
  return textSha256 || spokenText ? { textSha256, spokenText } : undefined;
}

function isAssistantTtsSupplementMessage(message: Record<string, unknown>): boolean {
  if (asRoleContentMessage(message)?.role !== "assistant") {
    return false;
  }
  if (!readTtsSupplementMarker(message)) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasSupplementBlock = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      hasSupplementBlock = true;
      continue;
    }
    const text =
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text.trim()
        : "";
    if (text && text !== "Audio reply") {
      return false;
    }
  }
  return hasSupplementBlock;
}

function ttsSupplementMatchesAssistant(
  marker: { textSha256?: string; spokenText?: string },
  message: Record<string, unknown>,
): boolean {
  if (asRoleContentMessage(message)?.role !== "assistant") {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(message)) {
    return false;
  }
  if (readTtsSupplementMarker(message)) {
    return false;
  }
  const text = extractProjectedText(message.content ?? message.text).trim();
  if (!text) {
    return false;
  }
  if (marker.textSha256 && digestTtsSupplementText(text) === marker.textSha256) {
    return true;
  }
  return Boolean(marker.spokenText && text === marker.spokenText);
}

function mergeTtsSupplementContent(
  target: Record<string, unknown>,
  supplement: Record<string, unknown>,
): Record<string, unknown> {
  const supplementBlocks = Array.isArray(supplement.content)
    ? supplement.content.filter(
        (block) =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type !== "text",
      )
    : [];
  if (supplementBlocks.length === 0) {
    return target;
  }
  const targetContent = target.content;
  if (Array.isArray(targetContent)) {
    return { ...target, content: [...targetContent, ...supplementBlocks] };
  }
  const targetText = extractProjectedText(targetContent ?? target.text).trim();
  return {
    ...target,
    content: [...(targetText ? [{ type: "text", text: targetText }] : []), ...supplementBlocks],
  };
}

export function mergeTtsSupplementMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!messages.some(isAssistantTtsSupplementMessage)) {
    return messages;
  }
  const merged: Array<Record<string, unknown>> = [];
  let changed = false;
  for (const message of messages) {
    const marker = readTtsSupplementMarker(message);
    if (marker && isAssistantTtsSupplementMessage(message)) {
      let targetIndex = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        const candidate = merged[i];
        if (candidate && ttsSupplementMatchesAssistant(marker, candidate)) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        merged[targetIndex] = mergeTtsSupplementContent(
          expectDefined(merged[targetIndex], "merged entry at target index"),
          message,
        );
        changed = true;
        continue;
      }
    }
    merged.push(message);
  }
  return changed ? merged : messages;
}

function isSubagentAnnounceInterSessionUserMessage(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = extractProjectedText(message.content ?? message.text);
  return (
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) && text.includes("sourceTool=subagent_announce")
  );
}

function readChatHistoryRecordTimestampMs(message: unknown): number | undefined {
  const meta = readRecord(readRecord(message)?.["__openclaw"]);
  const value = meta?.recordTimestampMs;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const timestamp = readRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function isSubagentAnnounceInterSessionUserChatHistoryMessage(message: unknown): boolean {
  const record = readRecord(message);
  if (!record || record.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(record.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = extractChatHistoryBlockText(record);
  return (
    typeof text === "string" &&
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) &&
    text.includes("sourceTool=subagent_announce")
  );
}

function isChatHistoryAssistantMessage(message: unknown): boolean {
  return readRecord(message)?.role === "assistant";
}

export function dropPreSessionStartAnnouncePairs(
  messages: unknown[],
  sessionStartedAt: number | undefined,
): unknown[] {
  if (sessionStartedAt === undefined || messages.length === 0) {
    return messages;
  }
  let changed = false;
  const kept: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (isSubagentAnnounceInterSessionUserChatHistoryMessage(current)) {
      const ts = readChatHistoryRecordTimestampMs(current);
      if (typeof ts === "number" && ts < sessionStartedAt) {
        const next = messages[i + 1];
        const nextTs = readChatHistoryRecordTimestampMs(next);
        if (
          isChatHistoryAssistantMessage(next) &&
          typeof nextTs === "number" &&
          nextTs < sessionStartedAt
        ) {
          // Skip only an assistant reply that is also pre-session-start; recent
          // or timestampless assistants may be real fresh-session context.
          i++;
        }
        changed = true;
        continue;
      }
    }
    kept.push(current);
  }
  return changed ? kept : messages;
}

function isDisplayHiddenProjectedMessage(message: Record<string, unknown>): boolean {
  if (message.display === false) {
    return true;
  }
  return message.role === "custom" && message.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE;
}

function shouldHideProjectedHistoryMessage(message: Record<string, unknown>): boolean {
  if (isDisplayHiddenProjectedMessage(message)) {
    return true;
  }
  if (isProjectedSessionsSendForwardedMessage(message)) {
    return false;
  }
  const roleContent = asRoleContentMessage(message);
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) {
    return true;
  }
  if (
    roleContent.role === "user" &&
    isEmptyTextOnlyContent(message.content ?? message.text) &&
    !hasTranscriptMediaFacts(message)
  ) {
    return true;
  }
  if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return false;
  }
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT)) {
    return true;
  }
  return isHeartbeatOkResponse(roleContent);
}

/** Identifies the hidden native input that starts a heartbeat-driven turn. */
export function isHeartbeatHistoryTurnBoundaryMessage(message: unknown): boolean {
  const record = readRecord(message);
  if (!record || isSessionsSendInterSessionUserMessage(record)) {
    return false;
  }
  const roleContent = asRoleContentMessage(record);
  return roleContent?.role === "user" && isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT);
}

function attachProjectedTurnBoundary(message: Record<string, unknown>): Record<string, unknown> {
  const metadata = readRecord(message["__openclaw"]);
  if (metadata?.turnBoundary === true) {
    return message;
  }
  return {
    ...message,
    __openclaw: {
      ...metadata,
      turnBoundary: true,
    },
  };
}

function canCarryProjectedTurnBoundary(message: RoleContentMessage | null): boolean {
  return Boolean(message && message.role !== "system" && message.role !== "custom");
}

function openclawAssistantModel(message: Record<string, unknown>): string | undefined {
  return message.role === "assistant" &&
    message.provider === "openclaw" &&
    typeof message.model === "string"
    ? message.model
    : undefined;
}

export function displayTextForDuplicateCheck(message: Record<string, unknown>): string | undefined {
  const text = extractProjectedText(message.content ?? message.text).trim();
  return text ? text : undefined;
}

function isDuplicateAcpGatewayInjectedMessage(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible) {
    return false;
  }
  if (
    openclawAssistantModel(previousVisible) !== "acp-runtime" ||
    openclawAssistantModel(current) !== "gateway-injected"
  ) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = displayTextForDuplicateCheck(previousVisible);
  const currentText = displayTextForDuplicateCheck(current);
  return Boolean(previousText && currentText && previousText === currentText);
}

function isDuplicateChannelFinalDeliveryMirror(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible || !isOpenClawDeliveryMirrorAssistantMessage(current)) {
    return false;
  }
  const deliveryMirror = readRecord(current.openclawDeliveryMirror);
  if (deliveryMirror?.kind !== "channel-final") {
    return false;
  }
  if (asRoleContentMessage(previousVisible)?.role !== "assistant") {
    return false;
  }
  if (isOpenClawDeliveryMirrorAssistantMessage(previousVisible)) {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(previousVisible)) {
    return false;
  }
  const previousMeta = readRecord(previousVisible["__openclaw"]);
  if (typeof previousMeta?.mirrorIdentity !== "string" || !previousMeta.mirrorIdentity.trim()) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = displayTextForDuplicateCheck(previousVisible);
  const currentText = displayTextForDuplicateCheck(current);
  return Boolean(previousText && currentText && previousText === currentText);
}

export function toProjectedMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

export function filterVisibleProjectedHistoryMessages(
  messages: Array<Record<string, unknown>>,
  turnBoundaryPending = false,
): {
  messages: Array<Record<string, unknown>>;
  turnBoundaryPending: boolean;
} {
  if (messages.length === 0) {
    return { messages, turnBoundaryPending };
  }
  let pendingTurnBoundary = turnBoundaryPending;
  let changed = false;
  const visible: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) {
      continue;
    }
    const currentRoleContent = asRoleContentMessage(current);
    const next = messages[i + 1];
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      currentRoleContent &&
      next &&
      nextRoleContent &&
      isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) &&
      isHeartbeatOkResponse(nextRoleContent) &&
      !isProjectedSessionsSendForwardedMessage(next)
    ) {
      changed = true;
      pendingTurnBoundary = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current)) {
      changed = true;
      pendingTurnBoundary ||= isHeartbeatHistoryTurnBoundaryMessage(current);
      continue;
    }
    if (
      isDuplicateAcpGatewayInjectedMessage(current, visible.at(-1)) ||
      isDuplicateChannelFinalDeliveryMirror(current, messages[i - 1])
    ) {
      changed = true;
      continue;
    }
    if (pendingTurnBoundary && canCarryProjectedTurnBoundary(currentRoleContent)) {
      visible.push(attachProjectedTurnBoundary(current));
      pendingTurnBoundary = false;
      changed = true;
    } else {
      visible.push(current);
    }
  }
  return {
    messages: changed ? visible : messages,
    turnBoundaryPending: pendingTurnBoundary,
  };
}

function stripInterSessionPromptPrefixFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripInterSessionPromptPrefixForDisplay(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return block;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text !== "string") {
      return block;
    }
    const stripped = stripInterSessionPromptPrefixForDisplay(record.text);
    return stripped === record.text ? block : { ...record, text: stripped };
  });
}

function extractPromptPrefixField(text: string, field: string): string | undefined {
  const prefixIndex = text.indexOf(INTER_SESSION_PROMPT_PREFIX_BASE);
  if (prefixIndex === -1) {
    return undefined;
  }
  const lineEnd = text.indexOf("\n", prefixIndex);
  const header = lineEnd === -1 ? text.slice(prefixIndex) : text.slice(prefixIndex, lineEnd);
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escapedField}=([^\\s]+)`).exec(header);
  return normalizeOptionalString(match?.[1]);
}

function resolveSessionsSendForwardedSenderLabel(message: Record<string, unknown>): string {
  const provenance = normalizeInputProvenance(message.provenance);
  const text = extractProjectedText(message.content ?? message.text);
  const sourceSessionKey =
    provenance?.sourceSessionKey ?? extractPromptPrefixField(text, "sourceSession");
  const agentId = parseAgentSessionKey(sourceSessionKey)?.agentId;
  return agentId ? `Forwarded from ${agentId}` : "Forwarded agent message";
}

export function projectSessionsSendInterSessionMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = messages.map((message) => {
    if (!isSessionsSendInterSessionUserMessage(message)) {
      return message;
    }
    changed = true;
    const next: Record<string, unknown> = {
      ...message,
      role: "assistant",
      senderLabel: resolveSessionsSendForwardedSenderLabel(message),
    };
    if ("content" in next) {
      next.content = stripInterSessionPromptPrefixFromContent(next.content);
    }
    if (typeof next.text === "string") {
      next.text = stripInterSessionPromptPrefixForDisplay(next.text);
    }
    return next;
  });
  return changed ? projected : messages;
}
