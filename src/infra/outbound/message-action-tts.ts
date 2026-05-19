import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";

let ttsRuntimePromise: Promise<typeof import("../../tts/tts.runtime.js")> | null = null;

function loadMessageActionTtsRuntime() {
  ttsRuntimePromise ??= import("../../tts/tts.runtime.js");
  return ttsRuntimePromise;
}

export function resolveMessageActionSessionTtsAuto(params: {
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
    const store = loadSessionStore(storePath);
    return resolveSessionStoreEntry({ store, sessionKey }).existing?.ttsAuto;
  } catch {
    return undefined;
  }
}

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
