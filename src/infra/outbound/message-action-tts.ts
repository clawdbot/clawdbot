// Message-action TTS helpers lazily apply session/config driven speech output
// to send payloads without loading TTS providers for ordinary sends.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveStorePath } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";

// Keep the TTS runtime lazy so ordinary message sends do not pay the provider import cost.
const loadMessageActionTtsRuntime = createLazyRuntimeModule(
  () => import("../../tts/tts.runtime.js"),
);

/** Reads the session-level TTS auto mode for a message-action send. */
function resolveMessageActionSessionTtsAuto(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): TtsAutoMode | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    return loadSessionEntryReadOnly({
      agentId: params.agentId,
      sessionKey,
      storePath,
    })?.ttsAuto;
  } catch {
    // Missing or unreadable session stores should not block message delivery.
    return undefined;
  }
}

/** Applies automatic TTS to a message-action send payload when config/session policy allows it. */
export async function maybeApplyTtsToMessageActionSendPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  agentId?: string;
  sessionKey?: string;
  inboundAudio?: boolean;
  dryRun: boolean;
}): Promise<ReplyPayload> {
  if (params.dryRun) {
    return params.payload;
  }
  const ttsAuto = resolveMessageActionSessionTtsAuto({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      ttsAuto,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId ?? undefined,
    })
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await loadMessageActionTtsRuntime();
  return await maybeApplyTtsToPayload({
    payload: params.payload,
    cfg: params.cfg,
    channel: params.channel,
    kind: "final",
    inboundAudio: params.inboundAudio,
    ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId ?? undefined,
  });
}
