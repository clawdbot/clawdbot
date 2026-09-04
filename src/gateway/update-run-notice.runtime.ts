import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { renderUpdateRunNotice, type UpdateRunNoticeKind } from "../infra/update-run-report.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import {
  resolveGatewayLifecycleNoticeRoute,
  sendGatewayLifecycleNotice,
} from "./server-restart-sentinel-notice.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/update-run");

/** Prepare routing before an update can replace lazily loaded channel modules. */
export function createUpdateRunNotifier(
  initial: UpdateRunRecord,
  cfg: OpenClawConfig = getRuntimeConfig(),
  deps: CliDeps = createDefaultDeps(),
) {
  const { sessionKey } = initial.origin;
  const session =
    sessionKey &&
    (!initial.origin.deliveryContext?.channel ||
      isInternalMessageChannel(initial.origin.deliveryContext.channel))
      ? loadSessionEntry(sessionKey)
      : undefined;
  const deliveryContext = mergeDeliveryContext(
    initial.origin.deliveryContext,
    deliveryContextFromSession(session?.entry),
  );
  const route = resolveGatewayLifecycleNoticeRoute({
    cfg,
    deliveryContext,
    threadId: initial.origin.deliveryContext?.threadId,
  });
  const internal =
    sessionKey && isInternalMessageChannel(deliveryContext?.channel) ? session : undefined;
  return async (run: UpdateRunRecord, kind: UpdateRunNoticeKind) => {
    const message = renderUpdateRunNotice(run, kind);
    const recorded =
      kind === "finished"
        ? run.verification.noticeDelivered === true
        : run.steps.some((step) => step.step === `notice:${kind}` && step.status === "completed");
    if (!message || recorded) {
      return { delivered: false, owned: recorded };
    }
    // Admission, the watcher, and successor startup share permanent delivery
    // ownership. A repeated phase or sentinel revision cannot send a fifth message.
    const deliveryIntentId = `update-run-${kind}:${run.runId}`;
    let delivered = false;
    if (route) {
      delivered = await sendGatewayLifecycleNotice({
        ...route,
        cfg,
        deps,
        sessionKey,
        message,
        deliveryIntentId,
      });
    } else if (internal?.entry) {
      const notice = await appendAssistantMessageToSessionTranscript({
        agentId: internal.agentId,
        sessionKey: internal.canonicalKey,
        expectedSessionId: internal.entry.sessionId,
        expectedLifecycleRevision: internal.entry.lifecycleRevision ?? null,
        storePath: internal.storePath,
        text: message,
        idempotencyKey: deliveryIntentId,
      }).catch((error: unknown) => ({ ok: false as const, reason: formatErrorMessage(error) }));
      delivered = notice.ok;
      if (!notice.ok) {
        log.warn(`update run notice append failed: ${notice.reason}`);
      }
    }
    if (delivered && kind === "finished") {
      recordUpdateRunVerification(run.runId, { noticeDelivered: true });
    }
    const custody = route ? findDeliveryIntentOwner(deliveryIntentId) : null;
    const owned = delivered || custody?.status === "pending" || custody?.status === "completed";
    if (owned && kind !== "finished") {
      recordUpdateRunStep(run.runId, {
        step: `notice:${kind}`,
        status: "completed",
        endedAtMs: Date.now(),
      });
    }
    return { delivered, owned };
  };
}

export async function notifyUpdateRunPhase(run: UpdateRunRecord): Promise<void> {
  if (run.phase === "activating" || run.phase === "finished") {
    await createUpdateRunNotifier(run)(run, run.phase);
  }
}
