/** Marker reason for packages preserved by an explicit `plugins uninstall --keep-files`. */
export const RETAINED_MANAGED_NPM_KEEP_FILES_REASON = "removed-managed-npm-install-retained";

/** Marker reason for stale generations retired by `openclaw doctor --fix`. */
export const RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON =
  "doctor-repaired-stale-managed-npm-generation";

/** Marker reason for a generation superseded by a managed npm update. */
export const RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON =
  "replaced-by-managed-npm-generation-update";

/** Marker reason for a managed npm install superseded by another plugin source. */
export const RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON = "replaced-by-plugin-source-change";

/** Marker reason for an uncommitted Codex inference activation kept for later GC. */
export const RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON =
  "openclaw-inference-activation-not-committed";

const RETAINED_MANAGED_NPM_CLEANUP_ELIGIBLE_REASONS = new Set<string>([
  RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
  RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
  RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON,
  RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
]);

export function isRetainedManagedNpmCleanupEligibleReason(reason: string): boolean {
  return RETAINED_MANAGED_NPM_CLEANUP_ELIGIBLE_REASONS.has(reason);
}
