import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

type MainRecoveryStateFields = Pick<
  SessionEntry,
  "abortedLastRun" | "restartRecoveryRuns" | "mainRestartRecovery"
>;

// restartRecoveryDeliveryRunId stays out of this patch: it keys delivery-claim
// adoption (agent-command-restart-recovery.ts), not recovery ownership, and
// clearing it here strands the paired delivery context on the successor entry.
export const MAIN_SESSION_RECOVERY_CLEAR_PATCH: Partial<MainRecoveryStateFields> = {
  abortedLastRun: false,
  restartRecoveryRuns: undefined,
  mainRestartRecovery: undefined,
};

export function buildMainSessionRecoveryClearPatch(
  entry?: Partial<MainRecoveryStateFields> | null,
): Partial<MainRecoveryStateFields> {
  if (
    entry?.abortedLastRun !== true &&
    entry?.restartRecoveryRuns === undefined &&
    entry?.mainRestartRecovery === undefined
  ) {
    return {};
  }
  return MAIN_SESSION_RECOVERY_CLEAR_PATCH;
}

export function clearMainSessionRecoveryAfterAgentRun(
  entry: SessionEntry,
  clearForceSafeTools: boolean | undefined,
): void {
  const aborted = entry.abortedLastRun === true;
  if (clearForceSafeTools && !aborted) {
    entry.restartRecoveryForceSafeTools = undefined;
  }
  if (!aborted) {
    Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
  }
}

export type { MainRecoveryStateFields };
