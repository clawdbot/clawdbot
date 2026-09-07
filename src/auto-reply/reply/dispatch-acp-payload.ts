// Prepares ACP reply payloads and applies TTS before delivery.
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import { prepareReplyPayloadForDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(
  () => import("../../tts/tts.runtime.js"),
);

export function prepareAcpDeliveryPayload(params: {
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  routed: boolean;
  messaging?: ChannelMessagingAdapter;
  accountId?: string;
}) {
  if (!params.routed) {
    return prepareReplyPayloadForDispatcher(params.dispatcher, params.kind, params.payload);
  }
  return normalizeReplyPayloadOutcome(params.payload, {
    transformReplyPayload: createChannelReplyTransform({
      messaging: params.messaging,
      cfg: params.cfg,
      accountId: params.accountId,
    }),
  });
}

export async function maybeApplyAcpTts(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  agentId?: string;
  channel?: string;
  accountId?: string;
  kind: ReplyDispatchKind;
  inboundAudio: boolean;
  ttsAuto?: TtsAutoMode;
  skipTts?: boolean;
}): Promise<ReplyPayload> {
  if (params.skipTts) {
    return params.payload;
  }
  if (isReplyPayloadStatusNotice(params.payload)) {
    return params.payload;
  }
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if (!ttsStatus) {
    return params.payload;
  }
  if (ttsStatus.autoMode === "inbound" && !params.inboundAudio) {
    return params.payload;
  }
  if (
    params.kind !== "final" &&
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    }) === "final"
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await dispatchAcpTtsRuntimeLoader.load();
  const applied = await maybeApplyTtsToPayload({
    payload: params.payload,
    cfg: params.cfg,
    channel: params.channel,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId,
  });
  return copyReplyPayloadMetadata(params.payload, applied);
}
