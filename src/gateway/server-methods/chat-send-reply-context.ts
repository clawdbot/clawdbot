// Hydrates Control UI (webchat) reply targets into the channel-agnostic
// ReplyTo* envelope fields so downstream reply-context handling matches the
// Discord path (reply_to_id + "Reply target of current user message" block).
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import {
  readSessionMessageByIdAsync,
  type SessionTranscriptReadScope,
} from "../session-transcript-readers.js";

// Reply targets are quoted context, not primary input: bound the body so a
// reply to a huge transcript entry cannot flood the prompt metadata.
const REPLY_CONTEXT_BODY_MAX_CHARS = 2000;

type ChatSendReplyContextFields = Partial<
  Pick<MsgContext, "ReplyToId" | "ReplyToBody" | "ReplyToSender">
>;

function extractReplyTargetText(message: unknown): string | undefined {
  const entry = asOptionalRecord(message);
  if (!entry) {
    return undefined;
  }
  if (typeof entry.text === "string" && entry.text.trim()) {
    return entry.text;
  }
  if (typeof entry.content === "string" && entry.content.trim()) {
    return entry.content;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const parts = entry.content
    .map((block) => {
      const record = asOptionalRecord(block);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.trim());
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function resolveReplyTargetSenderLabel(params: {
  message: unknown;
  cfg: OpenClawConfig;
  agentId?: string;
  userSenderLabel?: string;
}): string {
  const role = asOptionalRecord(params.message)?.role;
  if (role === "assistant") {
    return resolveAssistantIdentity({ cfg: params.cfg, agentId: params.agentId }).name;
  }
  const userLabel = params.userSenderLabel?.trim();
  return userLabel || "User";
}

/** Copies hydrated reply fields onto the inbound context without clobbering unset keys. */
export function applyChatSendReplyContextFields(
  ctx: MsgContext,
  fields: ChatSendReplyContextFields,
): void {
  if (fields.ReplyToId !== undefined) {
    ctx.ReplyToId = fields.ReplyToId;
  }
  if (fields.ReplyToBody !== undefined) {
    ctx.ReplyToBody = fields.ReplyToBody;
  }
  if (fields.ReplyToSender !== undefined) {
    ctx.ReplyToSender = fields.ReplyToSender;
  }
}

/**
 * Resolves a webchat reply target from session history. Always preserves the
 * reply_to_id linkage; body/sender hydrate only when the transcript message
 * still resolves, mirroring Discord's missing-referenced-message tolerance.
 */
export async function resolveChatSendReplyContext(params: {
  replyToId: string | undefined;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  sessionEntry?: SessionTranscriptReadScope["sessionEntry"];
  storePath: string | undefined;
  userSenderLabel?: string;
  warn?: (message: string) => void;
}): Promise<ChatSendReplyContextFields> {
  const replyToId = params.replyToId?.trim();
  if (!replyToId) {
    return {};
  }
  const fields: ChatSendReplyContextFields = { ReplyToId: replyToId };
  const sessionId = params.sessionEntry?.sessionId;
  if (!sessionId) {
    return fields;
  }
  try {
    const resolved = await readSessionMessageByIdAsync(
      {
        agentId: params.agentId,
        sessionEntry: params.sessionEntry,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      replyToId,
      { allowResetArchiveFallback: true },
    );
    if (!resolved.found) {
      return fields;
    }
    // Hydrate only what webchat displays: project the stored message through the
    // same chat.history display normalization so envelope wrappers, runtime
    // context, tool payloads, and reasoning-only content stay out of the prompt.
    const displayMessage = projectChatDisplayMessage(resolved.message);
    if (!displayMessage) {
      return fields;
    }
    const rawBody = extractReplyTargetText(displayMessage)?.trim();
    // Assistant targets additionally scrub tool-call markers, thinking tags,
    // and internal scaffolding, matching stored-message history text handling.
    const body =
      rawBody && displayMessage.role === "assistant"
        ? sanitizeAssistantVisibleTextWithProfile(rawBody, "history").trim()
        : rawBody;
    if (!body) {
      return fields;
    }
    fields.ReplyToBody = truncateUtf16Safe(body, REPLY_CONTEXT_BODY_MAX_CHARS);
    fields.ReplyToSender = resolveReplyTargetSenderLabel({
      message: displayMessage,
      cfg: params.cfg,
      agentId: params.agentId,
      userSenderLabel: params.userSenderLabel,
    });
    return fields;
  } catch (err) {
    params.warn?.(`chat.send reply context hydration failed for ${replyToId}: ${String(err)}`);
    return fields;
  }
}
