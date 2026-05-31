import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForMirror } from "./payloads.js";

type SourceReplyTranscriptMirrorParams = {
  action: string;
  channel: string;
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  toolContext?: ChannelThreadingToolContext;
  idempotencyKey?: string;
  deliveredPayload?: unknown;
};

type MirrorableSourceReplyTranscriptParams = SourceReplyTranscriptMirrorParams & {
  sessionKey: string;
};

function readStringArray(value: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(value);
}

function readFirstString(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(params[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveSourceReplyTarget(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["target", "to", "channelId", "chatId"]);
}

function resolveSourceReplyThreadId(params: SourceReplyTranscriptMirrorParams): string | undefined {
  return readFirstString(params.actionParams, ["threadId", "messageThreadId"]);
}

function resolveThreadedSourceTarget(
  params: SourceReplyTranscriptMirrorParams,
  requestedTarget: string,
): string {
  const threadId = resolveSourceReplyThreadId(params);
  if (!threadId) {
    return requestedTarget;
  }
  return (
    normalizeOptionalString(
      getChannelPlugin(params.channel as ChannelId)?.threading?.resolveCurrentChannelId?.({
        to: requestedTarget,
        threadId,
      }),
    ) ?? requestedTarget
  );
}

function hasExplicitDeliveryFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    return true;
  }
  const status = normalizeOptionalLowercaseString(record.status);
  if (status === "failed" || status === "error") {
    return true;
  }
  const deliveryStatus = normalizeOptionalLowercaseString(record.deliveryStatus);
  return deliveryStatus === "failed" || deliveryStatus === "error";
}

function isCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
): params is MirrorableSourceReplyTranscriptParams {
  if (params.action !== "send") {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return false;
  }
  const currentChannel = normalizeOptionalLowercaseString(
    params.toolContext?.currentChannelProvider,
  );
  if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) {
    return false;
  }
  const currentTarget = normalizeOptionalString(params.toolContext?.currentChannelId);
  if (!currentTarget) {
    return false;
  }
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (!requestedTarget) {
    return false;
  }
  return (
    requestedTarget === currentTarget ||
    resolveThreadedSourceTarget(params, requestedTarget) === currentTarget
  );
}

export async function mirrorDeliveredSourceReplyToTranscript(
  params: SourceReplyTranscriptMirrorParams,
): Promise<boolean> {
  if (hasExplicitDeliveryFailure(params.deliveredPayload)) {
    return false;
  }
  if (!isCurrentSourceConversation(params)) {
    return false;
  }

  const plan = createOutboundPayloadPlan([
    {
      text: readFirstString(params.actionParams, ["message", "content", "text", "caption"]) ?? "",
      mediaUrl: readFirstString(params.actionParams, [
        "mediaUrl",
        "media",
        "path",
        "filePath",
        "fileUrl",
      ]),
      mediaUrls: readStringArray(params.actionParams.mediaUrls),
      presentation: params.actionParams.presentation as ReplyPayload["presentation"],
      interactive: params.actionParams.interactive as ReplyPayload["interactive"],
      channelData: params.actionParams.channelData as ReplyPayload["channelData"],
    },
  ]);
  const mirror = projectOutboundPayloadPlanForMirror(plan);
  if (!mirror.text && mirror.mediaUrls.length === 0) {
    return false;
  }

  await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    text: mirror.text,
    mediaUrls: mirror.mediaUrls.length ? mirror.mediaUrls : undefined,
    idempotencyKey: params.idempotencyKey,
    config: params.cfg,
  });
  return true;
}
