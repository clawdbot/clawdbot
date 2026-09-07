// Matrix plugin module implements client behavior.
export type { MatrixAuth } from "./client/types.js";
export { getMatrixScopedEnvVarNames } from "../env-vars.js";
export {
  backfillMatrixAuthDeviceIdAfterStartup,
  hasReadyMatrixEnvAuth,
  resolveMatrixEnvAuthReadiness,
  resolveMatrixConfigForAccount,
  resolveScopedMatrixEnvConfig,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./client/config.js";
export { createMatrixClient } from "./client/create-client.js";
export { acquireSharedMatrixClient, stopSharedClientForAccount } from "./client/shared.js";
export type {
  MatrixClientLeaseRole,
  MatrixClientReleaseMode,
  MatrixMonitorRetirement,
  SharedMatrixClientLease,
} from "./client/shared.js";
