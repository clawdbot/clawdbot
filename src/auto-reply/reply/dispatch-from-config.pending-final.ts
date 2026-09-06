import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";

type PendingFinalDeliveryIdentity = NonNullable<
  ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]
>;

type PendingFinalDeliveryOptions = { preserveActivity?: boolean };

export async function suppressPendingFinalDelivery(
  payload: ReplyPayload | undefined,
  options: PendingFinalDeliveryOptions = {},
): Promise<void> {
  const completion = payload
    ? getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion
    : undefined;
  if (completion) {
    await settlePendingFinalDelivery(
      { kind: "pending-final", ...completion },
      "suppressed",
      ["prepared"],
      options,
    );
    await clearPendingFinalDeliveryAfterSuccess(completion, options);
  }
}

export async function clearPendingFinalDeliveryAfterSuccess(
  identity?: PendingFinalDeliveryIdentity,
  options: PendingFinalDeliveryOptions = {},
): Promise<void> {
  if (!identity) {
    return;
  }
  await patchSessionEntryCore(
    { storePath: identity.storePath, sessionKey: identity.sessionKey },
    (entry) => {
      const recoveryRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
      const deliveries = entry.pendingFinalDelivery?.deliveries;
      if (
        entry.sessionId !== identity.sessionId ||
        entry.pendingFinalDelivery?.intentId !== identity.intentId ||
        !deliveries?.length ||
        !deliveries.every(({ state }) => state === "delivered" || state === "suppressed") ||
        (recoveryRunId !== undefined && recoveryRunId !== identity.recoveryRunId)
      ) {
        return null;
      }
      const completesHookTurn =
        recoveryRunId === undefined &&
        (entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
          entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable");
      const endedAt = completesHookTurn ? Date.now() : undefined;
      return {
        ...(recoveryRunId
          ? buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: true })
          : {
              restartRecoveryBeforeAgentReplyState: undefined,
              restartRecoverySourceIngress: undefined,
              restartRecoveryForceSafeTools: undefined,
            }),
        pendingFinalDelivery: undefined,
        ...(endedAt === undefined
          ? {}
          : {
              abortedLastRun: false,
              endedAt,
              lifecycleRunId: undefined,
              runtimeMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, endedAt - entry.startedAt)
                  : undefined,
              status: "done" as const,
            }),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true, preserveActivity: options.preserveActivity },
  );
}
