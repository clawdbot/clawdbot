/**
 * Assembly stage — build the user-turn string the AI sees.
 *
 * Responsible for:
 *   - Rendering merged turns (preceding messages in a begin/end block
 *     + a "current" message).
 *   - Attaching the sender label + (@you) suffix for group chat.
 *   - Prepending the group's buffered history via
 *     {@link buildPendingHistoryContext} when the current turn is
 *     `@`-activated.
 *   - Handing out the plain `agentBody` for DM-style turns.
 *
 * The envelope rendering (Web UI body + dynamic ctx block) lives in
 * `envelope-stage.ts`; this stage only produces text that the model
 * sees directly.
 */

import {
  buildMergedMessageContext,
  formatAttachmentTags,
  formatMessageContent,
  type HistoryEntry,
} from "../../group/history.js";
import type { InboundGroupInfo, InboundPipelineDeps } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";

// ─────────────────────────── buildUserMessage ───────────────────────────

interface BuildUserMessageInput {
  event: QueuedMessage;
  userContent: string;
  quotePart: string;
  isGroupChat: boolean;
  groupInfo?: InboundGroupInfo;
}

/**
 * Compose the user-turn string. For merged group turns, renders a
 * preceding block and a current-message suffix; for single turns,
 * prefixes the sender label and (@you) suffix as appropriate.
 */
export function buildUserMessage(input: BuildUserMessageInput): string {
  const { event, userContent, quotePart, isGroupChat, groupInfo } = input;

  // ---- Merged group turn ----
  if (groupInfo?.isMerged && groupInfo.mergedMessages?.length) {
    const preceding = groupInfo.mergedMessages.slice(0, -1);
    const lastMsg = groupInfo.mergedMessages[groupInfo.mergedMessages.length - 1];
    const atYouTag = groupInfo.gate.effectiveWasMentioned ? " (@you)" : "";

    const envelopeParts = preceding.map((m) => `[${formatSenderLabel(m)}] ${formatSub(m)}`);
    const lastPart = `[${formatSenderLabel(lastMsg)}] ${formatSub(lastMsg)}${atYouTag}`;

    return buildMergedMessageContext({
      precedingParts: envelopeParts,
      currentMessage: lastPart,
    });
  }

  // ---- Single-message turn ----
  const isAtYouTag = isGroupChat ? (groupInfo?.gate.effectiveWasMentioned ? " (@you)" : "") : "";
  const senderPrefix =
    event.type === "group" ? `[${formatSenderLabelFrom(event.senderName, event.senderId)}] ` : "";

  return senderPrefix
    ? `${senderPrefix}${quotePart}${userContent}${isAtYouTag}`
    : `${quotePart}${userContent}`;
}

// ─────────────────────────── buildAgentBody ───────────────────────────

interface BuildAgentBodyInput {
  event: QueuedMessage;
  userContent: string;
  userMessage: string;
  dynamicCtx: string;
  isGroupChat: boolean;
  groupInfo?: InboundGroupInfo;
  deps: InboundPipelineDeps;
}

/**
 * Compose the final `agentBody` the AI receives.
 *
 * Prepends buffered non-@ chatter via
 * {@link buildPendingHistoryContext} when the current turn is
 * `@`-activated in a group. Slash-commands bypass all decoration so
 * the command parser sees verbatim input.
 */
export function buildAgentBody(input: BuildAgentBodyInput): string {
  const { event, userContent, userMessage, dynamicCtx, groupInfo, deps } = input;

  // Slash commands: strip all decoration so the command parser sees raw input.
  if (userContent.startsWith("/")) {
    return userContent;
  }

  const base = `${dynamicCtx}${userMessage}`;

  // Non-group or group-without-history: no mixing in.
  if (event.type !== "group" || !event.groupOpenid || !deps.groupHistories || !groupInfo) {
    return base;
  }

  const envelopeOpts = deps.runtime.channel.reply.resolveEnvelopeFormatOptions(deps.cfg);
  return deps.adapters.history.buildPendingHistoryContext({
    historyMap: deps.groupHistories,
    historyKey: event.groupOpenid,
    limit: groupInfo.historyLimit,
    currentMessage: base,
    formatEntry: (entry) => formatHistoryEntry(entry as HistoryEntry, deps, envelopeOpts),
  });
}

// ─────────────────────────── Internal ───────────────────────────

function formatSub(m: QueuedMessage): string {
  return formatMessageContent({
    content: m.content ?? "",
    chatType: m.type,
    mentions: m.mentions as never,
    attachments: m.attachments,
  });
}

function formatSenderLabel(m: QueuedMessage): string {
  return formatSenderLabelFrom(m.senderName, m.senderId);
}

/**
 * Render a "Nick (openid)" label. When `name` already includes `id`
 * (e.g. the label was pre-formatted upstream), avoid double-wrapping.
 */
function formatSenderLabelFrom(name: string | undefined, id: string): string {
  if (!name) {
    return id;
  }
  return name.includes(id) ? name : `${name} (${id})`;
}

function formatHistoryEntry(
  entry: HistoryEntry,
  deps: InboundPipelineDeps,
  envelopeOpts: unknown,
): string {
  const attachmentDesc = formatAttachmentTags(entry.attachments);
  const bodyWithAttachments = attachmentDesc ? `${entry.body} ${attachmentDesc}` : entry.body;
  return deps.runtime.channel.reply.formatInboundEnvelope({
    channel: "qqbot",
    from: entry.sender,
    timestamp: entry.timestamp,
    body: bodyWithAttachments,
    chatType: "group",
    envelope: envelopeOpts,
  });
}
