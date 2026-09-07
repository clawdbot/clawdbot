import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  attachManagedOutgoingMediaToMessage,
  removeManagedOutgoingMediaBlocks,
} from "../../gateway/managed-image-attachments.js";
import {
  buildAssistantReplyContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
} from "../../gateway/server-methods/chat-assistant-content.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
  resolveOutboundPayloadMirrorText,
} from "../../infra/outbound/payloads.js";
import { getAgentScopedMediaLocalRootsForSources } from "../../media/local-roots.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import { logCronDeliveryWarn } from "./delivery-dispatch-policy.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import { requiresExternalCronDelivery } from "./delivery-target.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean; deliveryError?: string };

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  text?: string,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
  }
  if (!params.sourceSessionGeneration) {
    return { ok: false, reason: "current cron delivery is missing its source session generation" };
  }
  const transcriptPayloads = buildDirectCronTranscriptMirrorPayloads(params.deliveryPayloads);
  const mirror = projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan(transcriptPayloads));
  const completionText =
    resolveDirectCronTranscriptMirrorText(mirror) ?? normalizeOptionalString(text);
  if (!completionText) {
    return { ok: false, reason: "current cron completion has no durable transcript projection" };
  }
  const runId = createCronExecutionId(params.job.id, params.runStartedAt);
  let preparedContent: Record<string, unknown>[] | undefined;
  let appended = false;
  try {
    const committed = await commitBackgroundResultToSession({
      agentId: params.agentId,
      sessionKey: sourceSessionKey,
      expectedGeneration: params.sourceSessionGeneration,
      text: completionText,
      prepareDisplayContent: async () => {
        const { assistantContent } = await buildAssistantReplyContent({
          sessionKey: sourceSessionKey,
          agentId: params.agentId,
          // Enrich each payload before rendering so rich text, media order, and
          // preparation notices all stay in the display builder's canonical flow.
          payloads: transcriptPayloads.map((payload) =>
            copyReplyPayloadMetadata(payload, {
              ...payload,
              text: resolveOutboundPayloadMirrorText(payload),
            }),
          ),
          managedMediaLocalRoots: getAgentScopedMediaLocalRootsForSources({
            cfg: params.cfgWithAgentDefaults,
            agentId: params.agentId,
            mediaSources: mirror.mediaUrls,
          }),
          includeSensitiveMedia: false,
          onManagedMediaPrepareError: (message) => {
            void logCronDeliveryWarn(
              `[cron:${params.job.id}] current-session completion media embedding skipped: ${message}`,
            );
          },
        });
        preparedContent = assistantContent;
        return hasAssistantDisplayMediaContent(preparedContent) ? preparedContent : undefined;
      },
      idempotencyKey: `cron-current-completion:${runId}`,
      provenance: { kind: "cron", jobId: params.job.id, runId },
      config: params.cfgWithAgentDefaults,
      signal: params.abortSignal,
      onMessageCommitted: (result) => {
        // Promote before publication; retries own the original committed blocks.
        // Preserve committed media even when promotion or the later drain fails.
        appended = result.appended;
        const blocks = readAssistantDisplayContent(result.message);
        if (
          hasManagedOutgoingAssistantContent(blocks) &&
          !attachManagedOutgoingMediaToMessage({ messageId: result.messageId, blocks })
        ) {
          throw new Error("Current-session completion media ownership could not be persisted");
        }
      },
    });
    if (!committed.ok) {
      return committed;
    }
  } finally {
    if (!appended && preparedContent) {
      await removeManagedOutgoingMediaBlocks({ blocks: preparedContent, messageId: null });
    }
  }
  if (params.sourceDeliveryOutcome.satisfiesSourceDelivery) {
    return { ok: true, requiresExternalDelivery: false };
  }
  if (params.resolvedDelivery.ok) {
    return { ok: true, requiresExternalDelivery: true };
  }
  // Committing the report cannot satisfy an explicit or remembered external
  // destination; retain its error even when selection produced no channel.
  if (requiresExternalCronDelivery(params.deliveryPlan, params.resolvedDelivery)) {
    return {
      ok: true,
      requiresExternalDelivery: false,
      deliveryError: params.resolvedDelivery.error.message,
    };
  }
  return { ok: true, requiresExternalDelivery: false };
}
