export {
  listSetupInferenceAuthOptions,
  listSetupInferenceManualProviders,
  listSetupInferencePrepareOptions,
} from "./setup-inference-auth-options.js";
export type {
  SetupInferenceAuthOption,
  SetupInferenceManualProvider,
  SetupInferencePrepareOption,
} from "./setup-inference-auth-options.js";
export type { SetupRecommendedInstall } from "../plugins/recommended-tool-installs.js";
export { SETUP_INFERENCE_TEST_TIMEOUT_MS } from "./setup-inference-core.js";
export type {
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
  BoundVerifySetupInferenceResult,
  CompleteSetupInferenceResult,
  DetectSetupInferenceDeps,
  ProviderAutoSetupInferenceKind,
  SetupInferenceCandidate,
  SetupInferenceDeps,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
  SetupInferenceKind,
  SetupInferenceStatus,
  SetupInferenceUnavailableCandidate,
  VerifySetupInferenceResult,
} from "./setup-inference-core.js";
export {
  detectSetupInference,
  detectSetupInferenceIsolated,
  listManualSetupInferenceOptions,
} from "./setup-inference-detect.js";
export { activateSetupInference } from "./setup-inference-activate.js";
export {
  completeSetupInference,
  resolvePersistentApplyInference,
  verifySetupInference,
  verifySetupInferenceConfig,
} from "./setup-inference-turn.js";
export type { ResolvePersistentApplyInferenceDeps } from "./setup-inference-turn.js";
