/**
 * Browser control service barrel.
 *
 * Re-exports the background control service and shared control-state helpers
 * used by the plugin entrypoint, Gateway proxy, and tests.
 */
export {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../control-service.js";
