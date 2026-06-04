import {
  buildShouldSuppressBuiltInModel as buildShouldSuppressBuiltInModelImpl,
  shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl,
} from "./model-suppression.js";

// Runtime re-export seam for tests and lazy catalog paths that need to stub
// built-in model suppression without loading the full model suppression module.
type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type BuildShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").buildShouldSuppressBuiltInModel;

export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}

/** Build a provider-aware predicate for hiding bundled models. */
export function buildShouldSuppressBuiltInModel(
  ...args: Parameters<BuildShouldSuppressBuiltInModel>
): ReturnType<BuildShouldSuppressBuiltInModel> {
  return buildShouldSuppressBuiltInModelImpl(...args);
}
