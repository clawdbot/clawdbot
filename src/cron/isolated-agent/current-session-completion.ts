import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import { logCronDeliveryWarn } from "./delivery-dispatch-policy.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import { resolvedDeliveryTargetsExternalChannel } from "./delivery-target.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean; deliveryError?: string };

const currentSessionCompletionMediaRuntimeLoader = createLazyImportLoader(async () => {
  const [assistantContent, assistantDisplay, managedMedia, localRoots] = await Promise.all([
    import("../../gateway/server-methods/chat-assistant-content.js"),
    import("../../shared/assistant-display-content.js"),
    import("../../gateway/managed-image-attachments.js"),
    import("../../media/local-roots.js"),
  ]);
  return {
    attachManagedOutgoingMediaToMessage: managedMedia.attachManagedOutgoingMediaToMessage,
    buildAssistantDisplayContentFromReplyPayloads:
      assistantContent.buildAssistantDisplayContentFromReplyPayloads,
    getAgentScopedMediaLocalRootsForSources: localRoots.getAgentScopedMediaLocalRootsForSources,
    hasAssistantDisplayMediaContent: assistantContent.hasAssistantDisplayMediaContent,
    hasManagedOutgoingAssistantContent: assistantContent.hasManagedOutgoingAssistantContent,
    readAssistantDisplayContent: assistantDisplay.readAssistantDisplayContent,
    removeManagedOutgoingMediaBlocks: managedMedia.removeManagedOutgoingMediaBlocks,
  };
});

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  deliveryPayloads: DispatchCronDeliveryParams["deliveryPayloads"],
  text?: string,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
  }
  if (!params.sourceSessionGeneration) {
    return { ok: false, reason: "current cron delivery is missing its source session generation" };
  }
  const completionText =
    resolveDirectCronTranscriptMirrorText(
      projectOutboundPayloadPlanForMirror(
        createOutboundPayloadPlan(buildDirectCronTranscriptMirrorPayloads(deliveryPayloads)),
      ),
    ) ?? normalizeOptionalString(text);
  if (!completionText) {
    return { ok: false, reason: "current cron completion has no durable transcript projection" };
  }

  const mediaSources = deliveryPayloads.flatMap((payload) => [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ]);
  const mediaRuntime =
    mediaSources.length > 0 ? await currentSessionCompletionMediaRuntimeLoader.load() : undefined;
  const assistantContent = mediaRuntime
    ? await mediaRuntime.buildAssistantDisplayContentFromReplyPayloads({
        sessionKey: sourceSessionKey,
        agentId: params.agentId,
        payloads: deliveryPayloads,
        managedMediaLocalRoots: mediaRuntime.getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          mediaSources,
        }),
        includeSensitiveMedia: false,
        onManagedMediaPrepareError: (message) => {
          void logCronDeliveryWarn(
            `[cron:${params.job.id}] current-session media embedding skipped attachment: ${message}`,
          );
        },
      })
    : undefined;
  const hasDisplayMedia = mediaRuntime?.hasAssistantDisplayMediaContent(assistantContent) ?? false;
  const hasManagedMedia =
    mediaRuntime?.hasManagedOutgoingAssistantContent(assistantContent) ?? false;
  const displayContent = hasDisplayMedia ? assistantContent : undefined;
  const cleanupPreparedMedia = async () => {
    if (mediaRuntime && displayContent) {
      await mediaRuntime.removeManagedOutgoingMediaBlocks({
        blocks: displayContent,
        messageId: null,
      });
    }
  };

  let preparedMediaCommitted = false;
  const runId = createCronExecutionId(params.job.id, params.runStartedAt);
  const committed = await commitBackgroundResultToSession({
    agentId: params.agentId,
    sessionKey: sourceSessionKey,
    expectedGeneration: params.sourceSessionGeneration,
    text: completionText,
    ...(displayContent ? { displayContent } : {}),
    ...(hasManagedMedia && mediaRuntime
      ? {
          onMessageCommitted: (result) => {
            // The committed row owns either these prepared blocks or the original
            // bytes from an idempotent retry; bind exactly that durable content.
            preparedMediaCommitted = result.appended;
            if (
              !mediaRuntime.attachManagedOutgoingMediaToMessage({
                messageId: result.messageId,
                blocks: mediaRuntime.readAssistantDisplayContent(result.message),
              })
            ) {
              throw new Error("current-session media ownership could not be persisted");
            }
          },
        }
      : {}),
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.job.id, runId },
    config: params.cfgWithAgentDefaults,
    signal: params.abortSignal,
  }).catch(async (error: unknown) => {
    if (!preparedMediaCommitted) {
      await cleanupPreparedMedia();
    }
    throw error;
  });
  if (!committed.ok) {
    await cleanupPreparedMedia();
    return committed;
  }
  if (!committed.appended) {
    await cleanupPreparedMedia();
  }

  if (params.sourceDeliveryOutcome.satisfiesSourceDelivery) {
    return { ok: true, requiresExternalDelivery: false };
  }
  if (params.resolvedDelivery.ok) {
    return { ok: true, requiresExternalDelivery: true };
  }
  // The completion is durably committed to the target conversation. When the
  // failed resolution names an external channel route, that route still owed a
  // send — report it as a delivery failure without failing the committed turn.
  // With no external route (internal webchat/Control UI conversations, or a
  // gateway with no channels configured), the commit IS the delivery.
  if (resolvedDeliveryTargetsExternalChannel(params.resolvedDelivery)) {
    return {
      ok: true,
      requiresExternalDelivery: false,
      deliveryError: params.resolvedDelivery.error.message,
    };
  }
  return { ok: true, requiresExternalDelivery: false };
}
