/**
 * Test SDK subpath for plugin package, registration, and public surface contracts.
 */
import { pluginRegistrationContractRegistry } from "../plugins/contracts/registry.js";
import {
  installPluginRegistrationContract,
  type PluginRegistrationContractParams,
} from "./test-helpers/plugin-registration-contract.js";

export {
  assertNoImportTimeSideEffects,
  createPluginRegistryFixture,
  registerProviders,
  registerTestPlugin,
  registerVirtualTestPlugin,
  requireProvider,
} from "./test-helpers/contracts-testkit.js";
export { describePackageManifestContract } from "./test-helpers/package-manifest-contract.js";
export { pluginRegistrationContractCases } from "./test-helpers/plugin-registration-contract-cases.js";

function resolvePluginRegistrationContract(pluginId: string) {
  return pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId);
}

/** Installs tests against the runtime plugin registration contract registry. */
export function describePluginRegistrationContract(params: PluginRegistrationContractParams) {
  installPluginRegistrationContract(params, resolvePluginRegistrationContract);
}
export {
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
  BUNDLED_RUNTIME_SIDECAR_BASENAMES,
  getPublicArtifactBasename,
} from "./test-helpers/public-artifacts.js";
export { loadBundledPluginPublicSurface } from "./test-helpers/public-surface-loader.js";
