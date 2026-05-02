export {
  assertNoImportTimeSideEffects,
  createPluginRegistryFixture,
  registerProviders,
  registerTestPlugin,
  registerVirtualTestPlugin,
  requireProvider,
  uniqueSortedStrings,
} from "./test-helpers/contracts-testkit.js";
export { runDirectImportSmoke } from "./test-helpers/direct-smoke.js";
export { describePackageManifestContract } from "./test-helpers/package-manifest-contract.js";
export { pluginRegistrationContractCases } from "./test-helpers/plugin-registration-contract-cases.js";
export { describePluginRegistrationContract } from "./test-helpers/plugin-registration-contract.js";
export {
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
  BUNDLED_RUNTIME_SIDECAR_BASENAMES,
  getPublicArtifactBasename,
} from "./test-helpers/public-artifacts.js";
export {
  loadBundledPluginPublicSurface,
  loadBundledPluginPublicSurfaceSync,
  resolveWorkspacePackagePublicModuleUrl,
} from "./test-helpers/public-surface-loader.js";
