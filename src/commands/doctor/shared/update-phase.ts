import { isTruthyEnvValue } from "../../../infra/env.js";

export const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";
export const UPDATE_POST_CORE_CONVERGENCE_ENV = "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE";
export const UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV =
  "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR";

/**
 * True iff the caller is the doctor pass that runs WHILE the core package
 * files are actively being swapped (e.g. inside `runGlobalPackageUpdateSteps`'
 * `postVerifyStep`). At this moment npm/pnpm machinery is busy and we must
 * NOT trigger fresh plugin installs that race with the in-flight package
 * manager activity. Configured plugin repair is deferred to the post-core
 * convergence pass.
 *
 * If post-core convergence is also set, treat the call as post-core
 * convergence (post-core wins). This lets a parent process re-enter doctor
 * with both flags set and still get repair behavior.
 *
 * NOTE: only consumers that route through this helper observe the
 * "post-core wins" semantics. Files that still read
 * `OPENCLAW_UPDATE_IN_PROGRESS` directly (`commands/doctor-update.ts`,
 * `commands/doctor-repair-mode.ts`, `commands/doctor.e2e-harness.ts`,
 * `flows/doctor-health-contributions.ts`) treat both flags as
 * "update-in-progress". This is intentional: those paths are control-flow
 * gates (skip warnings, skip checks, e2e shims) where update-in-progress
 * suppression is still the correct behavior even mid-convergence. Migrate
 * a direct reader only when its semantics genuinely diverge between the
 * two phases.
 */
export function isUpdatePackageSwapInProgress(env: NodeJS.ProcessEnv): boolean {
  if (isPostCoreConvergencePass(env)) {
    return false;
  }
  return isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]);
}

/**
 * True iff configured plugin install repair should be deferred because the
 * updater guarantees a later post-core convergence pass. Older updaters only
 * set `OPENCLAW_UPDATE_IN_PROGRESS`; when they run a newer doctor from the
 * swapped package, repair must proceed there or externalized plugins stay
 * missing until the operator manually runs doctor.
 */
export function shouldDeferConfiguredPluginInstallRepair(env: NodeJS.ProcessEnv): boolean {
  return (
    isUpdatePackageSwapInProgress(env) &&
    isTruthyEnvValue(env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV])
  );
}

/**
 * True iff this newer doctor is running under an older updater. Legacy
 * updaters set only `OPENCLAW_UPDATE_IN_PROGRESS`; they do not opt into the
 * post-core convergence pass, so configured plugin repair must happen now.
 */
export function isLegacyPackageUpdateDoctorPass(env: NodeJS.ProcessEnv): boolean {
  return isUpdatePackageSwapInProgress(env) && !shouldDeferConfiguredPluginInstallRepair(env);
}

/**
 * True iff we are running the post-core convergence pass: the core package
 * swap is done, the gateway has not been restarted yet, and configured plugin
 * repair MUST run before we hand control back for the restart.
 */
export function isPostCoreConvergencePass(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env[UPDATE_POST_CORE_CONVERGENCE_ENV]);
}
