/** The exact private config_machine_state namespace; never SQL LIKE (case-folding). */
export const UPDATE_RECOVERY_KEY_PREFIX = "update.recovery.";
export const UPDATE_RECOVERY_KEY_END = "update.recovery/";

/**
 * Row ownership only, NOT payload validity or mutation authority. Generic checkpoint
 * merging must not revert these rows; fenced recovery carry-forward validates and
 * replaces the entire owned projection from CURRENT state before sealing. Malformed
 * keys/payloads in the namespace still belong here and must fail that validation.
 * All other machine-state rows remain subject to normal preservation/conflict checks.
 */
export function isUpdateRecoveryMachineStateKey(stateKey: unknown): stateKey is string {
  return typeof stateKey === "string" && stateKey.startsWith(UPDATE_RECOVERY_KEY_PREFIX);
}
