// Transcript echo delivery sends best-effort preflight audio transcripts back
// through deliverable message channels.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

// The message runtime is heavy and only needed when echo delivery actually
// proceeds to a deliverable channel.
const loadMessageRuntime = createLazyRuntimeModule(() => import("../channels/message/runtime.js"));

/**
 * Default operator-visible transcript echo format for preflight audio transcription.
 * Unchanged from prior releases so existing `echoTranscript: true` installs keep the
 * same visible output on upgrade.
 */
export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  // Function replacer keeps `$` sequences in the transcript literal instead of
  // being parsed as String.prototype.replace substitution patterns.
  return format.replace("{transcript}", () => transcript);
}

/**
 * Prefer the bare inbound message id for shared reply delivery.
 * Only strip a leading `<channel>:` prefix when it matches the active provider
 * (e.g. `telegram:73299` → `73299`). Leave colon-bearing native ids intact
 * (Matrix event ids, Slack-style compound ids, etc.).
 */
function resolveEchoReplyToId(ctx: MsgContext): string | undefined {
  const channelHint = normalizeLowercaseStringOrEmpty(ctx.Provider ?? ctx.Surface ?? "");
  const candidates = [ctx.MessageSid, ctx.MessageSidFirst, ctx.MessageSidFull];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (channelHint) {
      const prefix = `${channelHint}:`;
      if (trimmed.toLowerCase().startsWith(prefix)) {
        const bare = trimmed.slice(prefix.length).trim();
        if (bare) {
          return bare;
        }
        continue;
      }
    }
    return trimmed;
  }
  return undefined;
}

/**
 * Effective channel replyToMode for transcript echoes.
 * Uses the canonical channel threading adapter (e.g. Telegram unset → "off")
 * rather than raw config lookups that default unset to "first".
 * Loaded lazily to avoid pulling the full reply-threading graph at module init.
 */
async function resolveChannelReplyToMode(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  chatType?: string | null;
}): Promise<"off" | "first" | "all" | "batched"> {
  const { resolveReplyToMode } = await import("../auto-reply/reply/reply-threading.js");
  return resolveReplyToMode(
    params.cfg,
    // Channel id is already lowercased by the caller.
    params.channel as Parameters<typeof resolveReplyToMode>[1],
    params.accountId,
    params.chatType,
  );
}

/** Sends a best-effort transcript echo back to the originating deliverable chat. */
export async function sendTranscriptEcho(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  transcript: string;
  format?: string;
  logSuccess?: boolean;
  failureLogPrefix?: string;
  /** Opt-in: quote/reply to the inbound voice note when the channel supports it. */
  reply?: boolean;
}): Promise<void> {
  const { ctx, cfg, transcript } = params;
  const channel = ctx.Provider ?? ctx.Surface ?? "";
  const to = ctx.OriginatingTo ?? ctx.From ?? "";

  if (!channel || !to) {
    if (shouldLogVerbose()) {
      logVerbose("media: echo-transcript skipped (no channel/to resolved from ctx)");
    }
    return;
  }

  const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
  if (!isDeliverableMessageChannel(normalizedChannel)) {
    if (shouldLogVerbose()) {
      logVerbose(
        `media: echo-transcript skipped (channel "${normalizedChannel}" is not deliverable)`,
      );
    }
    return;
  }

  const text = formatEchoTranscript(transcript, params.format ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT);

  try {
    // Keep reply-mode resolution inside the best-effort boundary: lazy imports and
    // channel threading adapters can throw; echo delivery must log-and-continue.
    // Only resolve when reply threading is opted in.
    let replyToId: string | undefined;
    let channelReplyToMode: "off" | "first" | "all" | "batched" | undefined;
    if (params.reply === true) {
      // Prefer an already-resolved inbound ReplyToMode (e.g. Slack per-channel room policy
      // prepared before dispatch). Falling back to the account/chat-type resolver would drop
      // matched-channel overrides such as channels.slack.channels.<id>.replyToMode: off.
      const prepared = ctx.ReplyToMode;
      if (
        prepared === "off" ||
        prepared === "first" ||
        prepared === "all" ||
        prepared === "batched"
      ) {
        channelReplyToMode = prepared;
      } else {
        // When enabled, still respect the channel's replyToMode: off (no-thread preference).
        // Route via ambient replyToId + replyToMode rather than payload.replyToId so delivery
        // policy treats the echo like normal channel replies (explicit payload replies bypass off).
        channelReplyToMode = await resolveChannelReplyToMode({
          cfg,
          channel: normalizedChannel,
          accountId: ctx.AccountId,
          chatType: ctx.ChatType,
        });
      }
      // Do not thread on replyToMode "first": the pre-agent echo is its own outbound
      // batch, so threading here would consume a fresh "first" slot and the later
      // agent response would also reply to the same inbound message. Reserve "first"
      // for the agent reply; only thread transcript echoes when policy is "all"
      // (or "batched", which intentionally replies with each batch).
      const allowThread = channelReplyToMode === "all" || channelReplyToMode === "batched";
      replyToId = allowThread ? resolveEchoReplyToId(ctx) : undefined;
    }

    const { sendDurableMessageBatchCore } = await loadMessageRuntime();
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: normalizedChannel,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      ...(replyToId && channelReplyToMode
        ? {
            replyToId,
            // Always pass the adapter-resolved mode (never invent "first" over channel defaults).
            replyToMode: channelReplyToMode,
          }
        : {}),
      // Prefer quoting the inbound voice note when the channel supports it so the
      // transcript sits under the audio bubble (Hermes-style review UX).
      payloads: [{ text }],
      bestEffort: true,
      durability: "best_effort",
    });
    if (send.status === "failed") {
      throw send.error;
    }
    if ((params.logSuccess ?? true) && shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
    }
  } catch (err) {
    const prefix = params.failureLogPrefix ?? "media: echo-transcript delivery failed";
    logVerbose(`${prefix}: ${String(err)}`);
  }
}
