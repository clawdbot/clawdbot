import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

type MainRecoveryStateFields = Pick<
  SessionEntry,
  "abortedLastRun" | "restartRecoveryRuns" | "mainRestartRecovery"
>;

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
