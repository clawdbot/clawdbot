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

async function acknowledgePendingDeliveryNotice(params: {
  sessionKey: string;
  storePath: string;
  sessionId: string;
  intentId: string;
  idempotencyKey: string;
}): Promise<void> {
  if (
    !(
      await appendAssistantMessageToSessionTranscript({
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        expectedSessionId: params.sessionId,
        text: PENDING_DELIVERY_NOTICE,
        idempotencyKey: params.idempotencyKey,
      })
    ).ok
  ) {
    return;
  }
  await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (current) =>
      current.sessionId === params.sessionId &&
      current.pendingDeliveryNotice?.intentId === params.intentId
        ? { pendingDeliveryNotice: undefined, updatedAt: Date.now() }
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
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
  try {
    const outcome = await runtime.sendRecoveryNotice({
      channel: context.channel,
      to: context.to,
      accountId: context.accountId,
      threadId: context.threadId,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey,
    });
    if (outcome.suppressed) {
      // Zero platform results: nothing user-visible was sent. Retain the debt
      // terminally instead of appending a transcript entry that claims it was.
      await updateSessionEntry({ sessionKey, storePath }, (current) =>
        current.sessionId === entry.sessionId &&
        current.pendingDeliveryNotice?.intentId === notice.intentId
          ? {
              pendingDeliveryNotice: { ...notice, state: "unresolved" as const },
              updatedAt: Date.now(),
            }
          : null,
      );
      return;
    }
  } catch {
    const owner = findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status === "completed") {
      await acknowledgePendingDeliveryNotice({
        sessionKey,
        storePath,
        sessionId: entry.sessionId,
        intentId: notice.intentId,
        idempotencyKey,
      });
    } else if (owner?.status === "failed") {
      await updateSessionEntry({ sessionKey, storePath }, (current) =>
        current.sessionId === entry.sessionId &&
        current.pendingDeliveryNotice?.intentId === notice.intentId
          ? {
              pendingDeliveryNotice: { ...notice, state: "unresolved" as const },
              updatedAt: Date.now(),
            }
          : null,
      );
    }
    return;
  }
  await acknowledgePendingDeliveryNotice({
    sessionKey,
    storePath,
    sessionId: entry.sessionId,
    intentId: notice.intentId,
    idempotencyKey,
  });
}
