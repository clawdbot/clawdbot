/**
 * Runtime seam for built-in model suppression.
 * Lets tests and lazy catalog paths stub suppression behavior without importing
 * the full suppression implementation at module load.
 */
import {
  buildShouldSuppressBuiltInModelCore,
  shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl,
} from "./model-suppression.js";

type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type BuildShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").buildShouldSuppressBuiltInModelCore;

/** Runtime-forwarded predicate for hiding bundled models. */
export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}

/** Build a provider-aware predicate for hiding bundled models. */
export function buildShouldSuppressBuiltInModel(
  ...args: Parameters<BuildShouldSuppressBuiltInModel>
): ReturnType<BuildShouldSuppressBuiltInModel> {
  return buildShouldSuppressBuiltInModelCore(...args);
}
