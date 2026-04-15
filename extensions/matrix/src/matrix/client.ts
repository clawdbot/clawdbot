export type { MatrixAuth } from "./client/types.js";
export { isBunRuntime } from "./client/runtime.js";
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
export {
  acquireSharedMatrixClient,
  removeSharedClientInstance,
  releaseSharedClientInstance,
  resolveSharedMatrixClient,
  stopSharedClientForAccount,
  stopSharedClientInstance,
} from "./client/shared.js";
