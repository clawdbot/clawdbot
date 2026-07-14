import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";

type ReplyRestartRecoveryClaimController = {
  clear: () => Promise<void>;
  isArmed: () => boolean;
  persist: () => Promise<void>;
};

export function createReplyRestartRecoveryClaimController(params: {
  admittedRunId?: unknown;
  getEntry: () => SessionEntry | undefined;
  isRestartAbort: () => boolean;
  resolveDeliveryContext: (entry: SessionEntry | undefined) => DeliveryContext | undefined;
  sessionId: string;
  sessionKey?: string;
  setEntry: (entry: SessionEntry) => void;
  storePath?: string;
}): ReplyRestartRecoveryClaimController {
  let recoveryRunId: string = randomUUID();
  let recoverySourceRunId: string | undefined;
  let tracked = false;

  const persist = async (): Promise<void> => {
    if (!params.sessionKey || !params.storePath) {
      return;
    }
    const entry = params.getEntry();
    const admittedRunId = normalizeOptionalString(params.admittedRunId);
    const activeClaimRunId = normalizeOptionalString(entry?.restartRecoveryDeliveryRunId);
    if (
      admittedRunId &&
      entry &&
      entry.restartRecoveryDeliveryContext === undefined &&
      activeClaimRunId === admittedRunId
    ) {
      // Clear the retry verifier as the transcript-only claim crosses into execution.
      const adopted = await updateSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (current) =>
          current.sessionId === params.sessionId &&
          current.status === "running" &&
          current.abortedLastRun !== true &&
          current.restartRecoveryDeliveryContext === undefined &&
          current.restartRecoveryDeliveryRunId === admittedRunId &&
          current.restartRecoveryDeliverySourceRunId === entry.restartRecoveryDeliverySourceRunId &&
          current.restartRecoveryDeliveryRequestFingerprint ===
            entry.restartRecoveryDeliveryRequestFingerprint
            ? { restartRecoveryDeliveryRequestFingerprint: undefined, updatedAt: Date.now() }
            : null,
      );
      if (!adopted) {
        throw new Error("restart recovery claim changed before agent adoption");
      }
      params.setEntry(adopted);
      recoveryRunId = admittedRunId;
      recoverySourceRunId = normalizeOptionalString(adopted.restartRecoveryDeliverySourceRunId);
      tracked = true;
      return;
    }

    const deliveryContext = params.resolveDeliveryContext(entry);
    if (!deliveryContext && !activeClaimRunId) {
      return;
    }
    const updatedAt = Date.now();
    const persisted = await updateSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      (current) => {
        if (current.sessionId !== params.sessionId || current.abortedLastRun === true) {
          return null;
        }
        const currentClaimRunId = normalizeOptionalString(current.restartRecoveryDeliveryRunId);
        if (activeClaimRunId) {
          if (currentClaimRunId !== activeClaimRunId || current.status === "running") {
            return null;
          }
          const retiredClaim = buildRestartRecoveryClaimCleanupPatch({
            entry: current,
            recordTerminalSource: true,
            terminalSourceRunId: normalizeOptionalString(
              current.restartRecoveryDeliverySourceRunId,
            ),
          });
          // A terminal owner cannot protect the next turn. Retire it and install
          // the new externally deliverable owner in the same transaction.
          return deliveryContext
            ? {
                ...retiredClaim,
                restartRecoveryDeliveryContext: deliveryContext,
                restartRecoveryDeliveryRequestFingerprint: undefined,
                restartRecoveryDeliveryRunId: recoveryRunId,
                restartRecoveryDeliverySourceRunId: undefined,
                updatedAt,
              }
            : { ...retiredClaim, updatedAt };
        }
        return currentClaimRunId === undefined && deliveryContext
          ? {
              restartRecoveryDeliveryContext: deliveryContext,
              restartRecoveryDeliveryRequestFingerprint: undefined,
              restartRecoveryDeliveryRunId: recoveryRunId,
              restartRecoveryDeliverySourceRunId: undefined,
              updatedAt,
            }
          : null;
      },
    );
    if (persisted) {
      params.setEntry(persisted);
      tracked = persisted.restartRecoveryDeliveryRunId === recoveryRunId;
    }
  };

  const clear = async (): Promise<void> => {
    if (!tracked || !params.sessionKey || !params.storePath || params.isRestartAbort()) {
      return;
    }
    const persisted = await updateSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      (current) =>
        current.sessionId === params.sessionId &&
        current.restartRecoveryDeliveryRunId === recoveryRunId
          ? {
              ...buildRestartRecoveryClaimCleanupPatch({
                entry: current,
                recordTerminalSource: true,
                terminalSourceRunId: recoverySourceRunId,
              }),
              updatedAt: Date.now(),
            }
          : null,
    );
    if (persisted) {
      params.setEntry(persisted);
    }
  };

  const isArmed = (): boolean => {
    if (!tracked || !params.sessionKey || !params.storePath) {
      return false;
    }
    const persisted = loadSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      clone: false,
      hydrateSkillPromptRefs: false,
    });
    return persisted?.abortedLastRun === true || params.getEntry()?.abortedLastRun === true;
  };

  return { clear, isArmed, persist };
}
