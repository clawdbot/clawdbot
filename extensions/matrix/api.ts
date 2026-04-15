export { matrixPlugin } from "./src/channel.js";
export * from "./src/setup-core.js";
export * from "./src/setup-surface.js";
export * from "./src/account-selection.js";
export * from "./src/env-vars.js";
export * from "./src/storage-paths.js";
export {
  createMatrixThreadBindingManager,
  getMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./src/matrix/thread-bindings.js";
export {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./src/matrix/thread-bindings-shared.js";
export { matrixOnboardingAdapter as matrixSetupWizard } from "./src/onboarding.js";

export const matrixSessionBindingAdapterChannels = ["matrix"] as const;
