import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import { normalizeInboundTextNewlines, sanitizeInboundSystemTags } from "./inbound-text.js";

export type FinalizeInboundContextOptions = {
  forceBodyForAgent?: boolean;
  forceBodyForCommands?: boolean;
  forceChatType?: boolean;
  forceConversationLabel?: boolean;
};

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return sanitizeInboundSystemTags(normalizeInboundTextNewlines(value));
}

function normalizeMediaType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function countMediaEntries(ctx: MsgContext): number {
  const pathCount = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths.length : 0;
  const urlCount = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls.length : 0;
  const single = ctx.MediaPath || ctx.MediaUrl ? 1 : 0;
  return Math.max(pathCount, urlCount, single);
}

export function finalizeInboundContext<T extends Record<string, unknown>>(
  ctx: T,
  opts: FinalizeInboundContextOptions = {},
): T & FinalizedMsgContext {
  const normalized = ctx as T & MsgContext;

  normalized.Body = sanitizeInboundSystemTags(
    normalizeInboundTextNewlines(typeof normalized.Body === "string" ? normalized.Body : ""),
  );
  normalized.RawBody = normalizeTextField(normalized.RawBody);
  normalized.CommandBody = normalizeTextField(normalized.CommandBody);
  normalized.Transcript = normalizeTextField(normalized.Transcript);
  normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
  normalized.ThreadHistoryBody = normalizeTextField(normalized.ThreadHistoryBody);
  if (Array.isArray(normalized.UntrustedContext)) {
    const normalizedUntrusted = normalized.UntrustedContext.map((entry) =>
      sanitizeInboundSystemTags(normalizeInboundTextNewlines(entry)),
    ).filter((entry) => Boolean(entry));
    normalized.UntrustedContext = normalizedUntrusted;
  }

  const chatType = normalizeChatType(normalized.ChatType);
  if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) {
    normalized.ChatType = chatType;
  }

  const bodyForAgentSource = opts.forceBodyForAgent
    ? normalized.Body
    : (normalized.BodyForAgent ??
      // Prefer "clean" text over legacy envelope-shaped Body when upstream forgets to set BodyForAgent.
      normalized.CommandBody ??
      normalized.RawBody ??
      normalized.Body);
  normalized.BodyForAgent = sanitizeInboundSystemTags(
    normalizeInboundTextNewlines(bodyForAgentSource),
  );

  const bodyForCommandsSource = opts.forceBodyForCommands
    ? (normalized.CommandBody ?? normalized.RawBody ?? normalized.Body)
    : (normalized.BodyForCommands ??
      normalized.CommandBody ??
      normalized.RawBody ??
      normalized.Body);
  normalized.BodyForCommands = sanitizeInboundSystemTags(
    normalizeInboundTextNewlines(bodyForCommandsSource),
  );

  const explicitLabel = normalizeOptionalString(normalized.ConversationLabel);
  if (opts.forceConversationLabel || !explicitLabel) {
    const resolved = normalizeOptionalString(resolveConversationLabel(normalized));
    if (resolved) {
      normalized.ConversationLabel = resolved;
    }
  } else {
    normalized.ConversationLabel = explicitLabel;
  }

  // Always set. Default-deny when upstream forgets to populate it.
  normalized.CommandAuthorized = normalized.CommandAuthorized === true;
  normalized.CommandTurn = resolveCommandTurnContext(normalized);
  if (normalized.CommandTurn.source === "native" || normalized.CommandTurn.source === "text") {
    normalized.CommandSource = normalized.CommandTurn.source;
    normalized.CommandAuthorized = normalized.CommandTurn.authorized;
  } else {
    normalized.CommandSource = undefined;
  }

  // MediaType/MediaTypes alignment:
  // - No media: do not inject defaults.
  // - Media present: ensure MediaType is always set, and MediaTypes is padded to match
  //   MediaPaths/MediaUrls length when possible.
  const mediaCount = countMediaEntries(normalized);
  if (mediaCount > 0) {
    const mediaType = normalizeMediaType(normalized.MediaType);
    const rawMediaTypes = Array.isArray(normalized.MediaTypes) ? normalized.MediaTypes : undefined;
    const normalizedMediaTypes = rawMediaTypes?.map((entry) => normalizeMediaType(entry));

    let mediaTypesFinal: string[] | undefined;
    if (normalizedMediaTypes && normalizedMediaTypes.length > 0) {
      const filled = normalizedMediaTypes.slice();
      while (filled.length < mediaCount) {
        filled.push(undefined);
      }
      mediaTypesFinal = filled.map((entry) => entry ?? DEFAULT_MEDIA_TYPE);
    } else if (mediaType) {
      mediaTypesFinal = [mediaType];
      while (mediaTypesFinal.length < mediaCount) {
        mediaTypesFinal.push(DEFAULT_MEDIA_TYPE);
      }
    } else {
      mediaTypesFinal = Array.from({ length: mediaCount }, () => DEFAULT_MEDIA_TYPE);
    }

    normalized.MediaTypes = mediaTypesFinal;
    normalized.MediaType = mediaType ?? mediaTypesFinal[0] ?? DEFAULT_MEDIA_TYPE;
  }

  return normalized as T & FinalizedMsgContext;
}
