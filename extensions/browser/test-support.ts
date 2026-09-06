/**
 * Browser test-support re-exports from shared plugin-sdk test fixtures.
 */
export {
  createCliRuntimeCapture,
  expectGeneratedTokenPersistedToGatewayAuth,
  type CliRuntimeCapture,
} from "openclaw/plugin-sdk/test-fixtures";
export { createTempHomeEnv, useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
export { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
