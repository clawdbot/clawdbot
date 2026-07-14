import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import {
  appendAssistantMessageToSessionTranscript,
  type SessionTranscriptDeliveryMirror,
} from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { appendReplyDispatcherBeforeDeliverCancelled } from "./reply-dispatcher.js";
import type { DispatcherOutcomeCountsView, ReplyDispatcher } from "./reply-dispatcher.types.js";
import { readDispatcherFailedCounts } from "./reply-dispatcher.types.js";

type SourceReplyTranscriptMirror = NonNullable<
  NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["sourceReplyTranscriptMirror"]
>;

type TranscriptMirror = SourceReplyTranscriptMirror & {
  expectedSessionId?: string;
  storePath?: string;
  preferText?: boolean;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  transcriptOwner?: boolean;
};

export async function mirrorDeliveredReplyToTranscript(params: {
  metadata?: TranscriptMirror;
  cfg: OpenClawConfig;
}): Promise<void> {
  const mirror = params.metadata;
  if (!mirror) {
    return;
  }
  try {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: mirror.sessionKey,
      agentId: mirror.agentId,
      ...(mirror.expectedSessionId ? { expectedSessionId: mirror.expectedSessionId } : {}),
      text: mirror.text,
      mediaUrls: mirror.preferText && mirror.text ? undefined : mirror.mediaUrls,
      idempotencyKey: mirror.idempotencyKey,
      ...(mirror.deliveryMirror ? { deliveryMirror: mirror.deliveryMirror } : {}),
      ...(mirror.storePath ? { storePath: mirror.storePath } : {}),
      updateMode: "inline",
      config: params.cfg,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: transcript mirror skipped: ${result.reason}`);
    }
  } catch (error) {
    logVerbose(
      `dispatch-from-config: transcript mirror failed after delivery: ${formatErrorMessage(error)}`,
    );
  }
}

/** Reads final outcome counters from dispatchers that expose them. */
export function getDispatcherFinalOutcomeCounts(dispatcher: DispatcherOutcomeCountsView): {
  cancelled: number;
  failed: number;
} {
  return {
    cancelled: dispatcher.getCancelledCounts?.().final ?? 0,
    failed: readDispatcherFailedCounts(dispatcher).final,
  };
}

export function transcriptMirrorForDeliveredPayload(
  metadata: TranscriptMirror,
  payload: ReplyPayload,
): TranscriptMirror | undefined {
  const sendable = resolveSendableOutboundReplyParts(payload);
  if (!sendable.text && sendable.mediaUrls.length === 0) {
    return undefined;
  }
  return {
    ...metadata,
    text: sendable.text,
    mediaUrls: sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined,
  };
}

const STALE_FOREGROUND_SUPPRESSED_FINAL_TEXT =
  "Channel final suppressed before delivery: stale foreground";

function captureSuppressedTranscriptMirror(params: {
  metadata: TranscriptMirror;
  payload: ReplyPayload;
  deliveryId?: string | number;
}): TranscriptMirror | undefined {
  const payloadMetadata = getReplyPayloadMetadata(params.payload);
  if (
    !params.metadata.transcriptOwner ||
    payloadMetadata?.foregroundDeliverySuppression?.reason !== "stale-foreground"
  ) {
    return undefined;
  }
  const sourceMessageId = normalizeOptionalString(params.metadata.deliveryMirror?.sourceMessageId);
  if (!sourceMessageId) {
    return undefined;
  }
  const { transcriptOwner: _transcriptOwner, ...metadata } = params.metadata;
  return {
    ...metadata,
    // The transcript owner already persisted the answer; this row records only delivery state.
    text: STALE_FOREGROUND_SUPPRESSED_FINAL_TEXT,
    mediaUrls: undefined,
    preferText: true,
    idempotencyKey: `channel-final-suppressed:${sourceMessageId}:${params.deliveryId ?? "single"}`,
    deliveryMirror: {
      kind: "channel-final-suppressed",
      reason: "stale-foreground",
      sourceMessageId,
    },
  };
}

export function captureDeliveredTranscriptMirror(params: {
  dispatcher: ReplyDispatcher;
  metadata?: TranscriptMirror;
  deliveryId?: string | number;
  captureToken?: object;
}): () => TranscriptMirror | undefined {
  if (!params.metadata || !params.dispatcher.appendBeforeDeliver) {
    return () => (params.metadata?.transcriptOwner ? undefined : params.metadata);
  }
  const metadata = params.metadata;
  let deliveredMetadata: TranscriptMirror | undefined;
  let suppressedMetadata: TranscriptMirror | undefined;
  let observedFinal = false;
  const { idempotencyKey, sessionKey } = metadata;
  params.dispatcher.appendBeforeDeliver((payload, info) => {
    if (info.kind !== "final") {
      return payload;
    }
    if (getReplyPayloadMetadata(payload)?.finalDeliveryCapture !== params.captureToken) {
      return payload;
    }
    observedFinal = true;
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const payloadMirror = payloadMetadata?.sourceReplyTranscriptMirror;
    if (
      payloadMirror &&
      payloadMirror.idempotencyKey === idempotencyKey &&
      payloadMirror.sessionKey === sessionKey
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(
        {
          ...payloadMirror,
          ...(metadata.expectedSessionId ? { expectedSessionId: metadata.expectedSessionId } : {}),
          storePath: metadata.storePath,
        },
        payload,
      );
    } else if (
      !payloadMirror &&
      !metadata.transcriptOwner &&
      (!idempotencyKey || metadata.deliveryMirror)
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(metadata, payload);
    }
    return payload;
  });
  appendReplyDispatcherBeforeDeliverCancelled(params.dispatcher, (payload, info) => {
    if (info.kind !== "final") {
      return;
    }
    if (getReplyPayloadMetadata(payload)?.finalDeliveryCapture !== params.captureToken) {
      return;
    }
    observedFinal = true;
    suppressedMetadata = captureSuppressedTranscriptMirror({
      metadata,
      payload,
      deliveryId: params.deliveryId,
    });
  });
  return () =>
    observedFinal
      ? (suppressedMetadata ?? deliveredMetadata)
      : metadata.transcriptOwner
        ? undefined
        : metadata;
}

export async function mirrorTranscriptAfterDispatcherSettled(params: {
  dispatcher: ReplyDispatcher;
  before: { cancelled: number; failed: number };
  metadata: () => TranscriptMirror | undefined;
  cfg: OpenClawConfig;
}): Promise<void> {
  const after = getDispatcherFinalOutcomeCounts(params.dispatcher);
  const metadata = params.metadata();
  if (!metadata) {
    return;
  }
  const suppressedFinal = metadata.deliveryMirror?.kind === "channel-final-suppressed";
  if (
    !suppressedFinal &&
    (after.cancelled > params.before.cancelled || after.failed > params.before.failed)
  ) {
    return;
  }
  await mirrorDeliveredReplyToTranscript({
    metadata,
    cfg: params.cfg,
  });
}
