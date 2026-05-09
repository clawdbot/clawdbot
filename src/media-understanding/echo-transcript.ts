import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

let messageRuntimePromise: Promise<typeof import("../channels/message/runtime.js")> | null = null;

function loadMessageRuntime() {
  messageRuntimePromise ??= import("../channels/message/runtime.js");
  return messageRuntimePromise;
}

export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  return format.replace("{transcript}", transcript);
}

/**
 * Sends the transcript echo back to the originating chat.
 * Best-effort: logs on failure, never throws.
 */
export async function sendTranscriptEcho(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  transcript: string;
  format?: string;
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
    const { sendDurableMessageBatch } = await loadMessageRuntime();
    const send = await sendDurableMessageBatch({
      cfg,
      channel: normalizedChannel,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      payloads: [{ text }],
      bestEffort: true,
      durability: "best_effort",
    });
    if (send.status === "failed") {
      throw send.error;
    }
    if (shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
    }
  } catch (err) {
    logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
  }
}
