export {
  listSetupInferenceAuthOptions,
  listSetupInferenceManualProviders,
} from "./setup-inference-auth-options.js";
export type {
  SetupInferenceAuthOption,
  SetupInferenceManualProvider,
} from "./setup-inference-auth-options.js";
export type { SetupRecommendedInstall } from "../plugins/recommended-tool-installs.js";
export {
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceActivationIndeterminateError,
} from "./setup-inference-core.js";
export type {
  ActivateSetupInferenceDeps,
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
  BoundVerifySetupInferenceResult,
  CompleteSetupInferenceResult,
  DetectSetupInferenceDeps,
  ProviderAutoSetupInferenceKind,
  SetupInferenceCandidate,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
  SetupInferenceKind,
  SetupInferenceStatus,
  SetupInferenceUnavailableCandidate,
  VerifySetupInferenceResult,
} from "./setup-inference-core.js";
export { detectSetupInference, listManualSetupInferenceOptions } from "./setup-inference-detect.js";
export { activateSetupInference } from "./setup-inference-activate.js";
export {
  completeSetupInference,
  completeSetupInferenceConfig,
  resolvePersistentApplyInference,
  verifySetupInference,
  verifySetupInferenceConfig,
} from "./setup-inference-verify.js";
export type { ResolvePersistentApplyInferenceDeps } from "./setup-inference-verify.js";
