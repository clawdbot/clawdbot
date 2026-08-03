/**
 * Stable lazy-load facade for the gateway server implementation.
 *
 * Keep this path lightweight for callers and tests that import the public server contract.
 */
export {
  shouldRetainControlUiDeviceAuthMigrationSession,
  type GatewayCloseOptions,
  type GatewayServer,
  type GatewayServerOptions,
} from "./server-public.js";
export { resetPreparedModelCatalogForTest, startGatewayServer } from "./server-start.js";
