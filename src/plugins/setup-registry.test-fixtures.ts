/** Test-only setup inventory reset. */
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

export function clearPluginSetupRegistryCache(): void {
  clearPluginMetadataLifecycleCaches();
}
