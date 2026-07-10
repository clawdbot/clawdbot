/** Internal doctor invocation capabilities shared by direct and automated callers. */
import { isTruthyEnvValue } from "../infra/env.js";
import { UPDATE_IN_PROGRESS_ENV } from "./doctor/shared/update-phase.js";

export const DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV =
  "OPENCLAW_DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS";

/** Direct CLI doctor owns cross-state imports unless its automation parent denies them. */
export function resolveDoctorCrossStateDirImports(env: NodeJS.ProcessEnv = process.env): boolean {
  // Older update parents know only OPENCLAW_UPDATE_IN_PROGRESS. Treat that
  // existing cross-version handshake as deny-by-default for a newer doctor.
  return !(
    isTruthyEnvValue(env[DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV]) ||
    isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV])
  );
}
