// Normalizes raw agent output into sendable reply text and metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import {
  HEARTBEAT_TOKEN,
  isInternalFormattingArtifact,
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { hasCotFramePrefix } from "./cot-frame.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";

export type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";

export type NormalizeReplyOutcome<T = ReplyPayload> =
  | { kind: "deliver"; payload: T }
  | { kind: "suppress"; reason: NormalizeReplySkipReason };

const channelReplyTransformOwners = new WeakMap<
  (payload: ReplyPayload) => ReplyPayload | null,
  object
>();

export function bindNormalizeReplyTransformOwner<
  T extends (payload: ReplyPayload) => ReplyPayload | null,
>(transform: T, owner: object): T {
  channelReplyTransformOwners.set(transform, owner);
  return transform;
}

function resolveNormalizeReplyTransformOwner(
  transform: ((payload: ReplyPayload) => ReplyPayload | null) | undefined,
): object | undefined {
  return transform ? (channelReplyTransformOwners.get(transform) ?? transform) : undefined;
}

type NormalizeReplyOptions = {
  responsePrefix?: string;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  silentToken?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  conversationContext?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

export function normalizeReplyPayloadOutcome(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): NormalizeReplyOutcome {
  const suppress = (reason: NormalizeReplySkipReason): NormalizeReplyOutcome => {
    opts.onSkip?.(reason);
    return { kind: "suppress", reason };
  };
  const applyChannelTransforms = opts.applyChannelTransforms ?? true;
  const hasContent = (text: string | undefined) =>
    hasReplyPayloadContent(
      {
        ...payload,
        text,
      },
      {
        trimText: true,
      },
    );
  const trimmed = normalizeOptionalString(payload.text) ?? "";
  if (!hasContent(trimmed)) {
    return suppress("empty");
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyPayloadText(text, silentToken)) {
    if (!hasContent("")) {
      return suppress("silent");
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && !isSilentReplyText(text, silentToken)) {
    const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
    if (hasLeadingSilentToken) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    if (hasLeadingSilentToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
      text = stripSilentToken(text, silentToken);
      if (!hasContent(text)) {
        return suppress("silent");
      }
    }
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  // Treat bracketed internal narration frames as silent so they never reach
  // end users. This mirrors NO_REPLY semantics for fully silent payloads.
  // (Restored after upstream refactor 00d8d7ead0 removed this block; our
  // continuation feature still needs CoT-frame suppression for internal
  // narration emitted by heartbeat / continuation pathways.)
  if (text && hasCotFramePrefix(text)) {
    if (!hasContent("")) {
      return suppress("silent");
    }
    // Media-only fallback: drop the leaked text but let media still send.
    text = "";
  }

  if (text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (stripped.shouldSkip && !hasContent(stripped.text)) {
      return suppress("heartbeat");
    }
    text = stripped.text;
  }

  if (text && isInternalFormattingArtifact(text) && !hasContent("")) {
    return suppress("silent");
  }

  if (text) {
    text = payload.isError
      ? renderUserFacingText(text, {
          errorContext: true,
          conversationContext: opts.conversationContext,
        })
      : sanitizeUserFacingText(text, { conversationContext: opts.conversationContext });
  }
  if (!hasContent(text)) {
    return suppress("empty");
  }

  let enrichedPayload: ReplyPayload = copyReplyPayloadMetadata(payload, { ...payload, text });
  const channelTransformOwner = resolveNormalizeReplyTransformOwner(opts.transformReplyPayload);
  const transformAlreadyApplied =
    channelTransformOwner != null &&
    getReplyPayloadMetadata(enrichedPayload)?.channelReplyTransformOwner === channelTransformOwner;
  if (applyChannelTransforms && opts.transformReplyPayload && !transformAlreadyApplied) {
    const transformedPayload = opts.transformReplyPayload(enrichedPayload);
    if (transformedPayload === null) {
      return suppress("channel_transform");
    }
    const copiedPayload = transformedPayload
      ? copyReplyPayloadMetadata(enrichedPayload, transformedPayload)
      : enrichedPayload;
    const appliedOwner = resolveNormalizeReplyTransformOwner(opts.transformReplyPayload);
    enrichedPayload = appliedOwner
      ? setReplyPayloadMetadata(copiedPayload, { channelReplyTransformOwner: appliedOwner })
      : copiedPayload;
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  enrichedPayload = copyReplyPayloadMetadata(enrichedPayload, { ...enrichedPayload, text });
  return { kind: "deliver", payload: enrichedPayload };
}

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const outcome = normalizeReplyPayloadOutcome(payload, opts);
  return outcome.kind === "deliver" ? outcome.payload : null;
}
