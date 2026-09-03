import {
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

function noticeId(intentId: string): string {
  return `main-session-restart-recovery:pending-final:${intentId}`;
}

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
): Promise<void> {
  const entry = loadSessionEntryReadOnly({
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const notice = entry?.pendingDeliveryNotice;
  const context = normalizeDeliveryContext(notice?.context);
  const runtime = getGatewayRecoveryRuntime();
  if (
    !entry ||
    !runtime ||
    !notice ||
    notice.state !== "owed" ||
    !context?.channel ||
    !context.to ||
    deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry))
  ) {
    return;
  }
  const idempotencyKey = noticeId(notice.intentId);
  let delivered: boolean;
  try {
    const outcome = await runtime.sendRecoveryNotice({
      channel: context.channel,
      to: context.to,
      accountId: context.accountId,
      threadId: context.threadId,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey,
    });
    delivered = !outcome.suppressed;
  } catch {
    const owner = findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status !== "completed" && owner?.status !== "failed") {
      return;
    }
    delivered = owner.status === "completed";
  }
  if (
    delivered &&
    !(
      await appendAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        expectedSessionId: entry.sessionId,
        text: PENDING_DELIVERY_NOTICE,
        idempotencyKey,
      })
    ).ok
  ) {
    return;
  }
  await updateSessionEntry(
    { sessionKey, storePath },
    (current) =>
      current.sessionId === entry.sessionId &&
      current.pendingDeliveryNotice?.intentId === notice.intentId &&
      current.pendingDeliveryNotice.state !== "acknowledged"
        ? {
            // Retain the terminal fact: queue settlement may replay after this
            // acknowledgment, and one intent must never owe its notice again.
            pendingDeliveryNotice: {
              ...current.pendingDeliveryNotice,
              state: delivered ? "acknowledged" : "unresolved",
            },
            updatedAt: Date.now(),
          }
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
