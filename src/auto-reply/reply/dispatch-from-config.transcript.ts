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
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

type SourceReplyTranscriptMirror = NonNullable<
  NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["sourceReplyTranscriptMirror"]
>;

type TranscriptMirror = SourceReplyTranscriptMirror & {
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
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
  if (!mirror || mirror.transcriptOwner) {
    return;
  }
  try {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: mirror.sessionKey,
      agentId: mirror.agentId,
      ...(mirror.expectedSessionId ? { expectedSessionId: mirror.expectedSessionId } : {}),
      ...(mirror.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: mirror.expectedLifecycleRevision }
        : {}),
      ...(mirror.expectedWriterRunId !== undefined
        ? { expectedWriterRunId: mirror.expectedWriterRunId }
        : {}),
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

export function captureDeliveredTranscriptMirror(params: {
  dispatcher: ReplyDispatcher;
  metadata?: TranscriptMirror;
  captureToken?: object;
}): () => TranscriptMirror | undefined {
  if (!params.metadata || !params.dispatcher.appendBeforeDeliver) {
    return () => (params.metadata?.transcriptOwner ? undefined : params.metadata);
  }
  const metadata = params.metadata;
  let deliveredMetadata: TranscriptMirror | undefined;
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
          ...(metadata.expectedLifecycleRevision !== undefined
            ? { expectedLifecycleRevision: metadata.expectedLifecycleRevision }
            : {}),
          ...(metadata.expectedWriterRunId !== undefined
            ? { expectedWriterRunId: metadata.expectedWriterRunId }
            : {}),
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
  return () =>
    observedFinal ? deliveredMetadata : metadata.transcriptOwner ? undefined : metadata;
}

export async function mirrorTranscriptAfterDispatcherSettled(params: {
  outcome: Promise<ReplyDispatchDeliveryOutcome>;
  metadata: () => TranscriptMirror | undefined;
  cfg: OpenClawConfig;
}): Promise<void> {
  if ((await params.outcome) !== "delivered") {
    return;
  }
  const metadata = params.metadata();
  if (!metadata) {
    return;
  }
  await mirrorDeliveredReplyToTranscript({
    metadata,
    cfg: params.cfg,
  });
}
