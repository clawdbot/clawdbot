import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  isCompletionReportInputProvenance,
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

type TtsSupplementMarker = { textSha256?: string; spokenText?: string };

function readTtsSupplementMarker(
  message: Record<string, unknown>,
): TtsSupplementMarker | undefined {
  const marker = readRecord(message.openclawTtsSupplement);
  if (!marker) {
    return undefined;
  }
  const textSha256 =
    typeof marker.textSha256 === "string" && marker.textSha256.trim()
      ? marker.textSha256.trim()
      : undefined;
  const spokenText =
    typeof marker.spokenText === "string" && marker.spokenText.trim()
      ? marker.spokenText.trim()
      : undefined;
  return textSha256 || spokenText ? { textSha256, spokenText } : undefined;
}

function readAssistantTtsSupplementMarker(
  message: Record<string, unknown>,
): TtsSupplementMarker | undefined {
  const marker = readTtsSupplementMarker(message);
  if (!marker || asRoleContentMessage(message)?.role !== "assistant") {
    return undefined;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  let hasSupplementBlock = false;
  for (const block of content) {
    const record = readRecord(block);
    if (!record) {
      continue;
    }
    if (record.type !== "text") {
      hasSupplementBlock = true;
      continue;
    }
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text && text !== "Audio reply") {
      return undefined;
    }
  }
  return hasSupplementBlock ? marker : undefined;
}

function readTtsSupplementTargetText(message: Record<string, unknown>): string {
  return asRoleContentMessage(message)?.role === "assistant" &&
    !isProjectedSessionsSendForwardedMessage(message) &&
    !readTtsSupplementMarker(message)
    ? extractProjectedText(message.content ?? message.text).trim()
    : "";
}

function mergeTtsSupplementContent(
  target: Record<string, unknown>,
  supplement: Record<string, unknown>,
): Record<string, unknown> {
  const supplementBlocks = Array.isArray(supplement.content)
    ? supplement.content.filter((block) => {
        const record = readRecord(block);
        return record !== undefined && record.type !== "text";
      })
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
  if (!messages.some(readAssistantTtsSupplementMarker)) {
    return messages;
  }
  const targetTexts: Array<string | undefined> = [];
  const targetHashes: Array<string | undefined> = [];
  const merged: Array<Record<string, unknown>> = [];
  let changed = false;
  for (const message of messages) {
    const marker = readAssistantTtsSupplementMarker(message);
    if (marker) {
      let targetIndex = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        const candidate = merged[i];
        if (!candidate) {
          continue;
        }
        const text = (targetTexts[i] ??= readTtsSupplementTargetText(candidate));
        if (
          text &&
          ((marker.textSha256 &&
            (targetHashes[i] ??= createHash("sha256").update(text).digest("hex")) ===
              marker.textSha256) ||
            (marker.spokenText && text === marker.spokenText))
        ) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        merged[targetIndex] = mergeTtsSupplementContent(
          expectDefined(merged[targetIndex], "merged entry at target index"),
          message,
        );
        // Appended media can carry text. Only this replaced position loses its
        // prepared facts; other positions still refer to their original messages.
        targetTexts[targetIndex] = targetHashes[targetIndex] = undefined;
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
  return asFiniteNumber(meta?.recordTimestampMs) ?? asFiniteNumber(readRecord(message)?.timestamp);
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

function shouldHideProjectedHistoryMessage(
  message: Record<string, unknown>,
  roleContent: RoleContentMessage | null,
  heartbeatUser: boolean,
): boolean {
  if (isDisplayHiddenProjectedMessage(message)) {
    return true;
  }
  if (isProjectedSessionsSendForwardedMessage(message)) {
    return false;
  }
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isCompletionReportInputProvenance(message.provenance)) {
    return true;
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
  return heartbeatUser || isHeartbeatOkResponse(roleContent);
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
    const heartbeatUser = Boolean(
      currentRoleContent && isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT),
    );
    const next = heartbeatUser ? messages[i + 1] : undefined;
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      next &&
      nextRoleContent &&
      isHeartbeatOkResponse(nextRoleContent) &&
      !isProjectedSessionsSendForwardedMessage(next)
    ) {
      changed = true;
      pendingTurnBoundary = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current, currentRoleContent, heartbeatUser)) {
      changed = true;
      pendingTurnBoundary ||= heartbeatUser && !isSessionsSendInterSessionUserMessage(current);
      continue;
    }
    if (
      isDuplicateAcpGatewayInjectedMessage(current, messages[i - 1]) ||
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

function resolveSessionsSendForwardedSenderSession(
  message: Record<string, unknown>,
): { sessionKey?: string; agentId?: string } | undefined {
  const provenance = normalizeInputProvenance(message.provenance);
  const text = extractProjectedText(message.content ?? message.text);
  const sourceSessionKey =
    provenance?.sourceSessionKey ?? extractPromptPrefixField(text, "sourceSession");
  const agentId = parseAgentSessionKey(sourceSessionKey)?.agentId;
  return sourceSessionKey
    ? { sessionKey: sourceSessionKey, ...(agentId ? { agentId } : {}) }
    : undefined;
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
    const senderSession = resolveSessionsSendForwardedSenderSession(message);
    const next: Record<string, unknown> = {
      ...message,
      role: "assistant",
      senderLabel: senderSession?.agentId
        ? `Forwarded from ${senderSession.agentId}`
        : "Forwarded agent message",
      ...(senderSession ? { senderSession } : {}),
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
