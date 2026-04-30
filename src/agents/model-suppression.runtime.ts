import {
  buildShouldSuppressBuiltInModel as buildShouldSuppressBuiltInModelImpl,
  shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl,
} from "./model-suppression.js";

type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type BuildShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").buildShouldSuppressBuiltInModel;

export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}

export function buildShouldSuppressBuiltInModel(
  ...args: Parameters<BuildShouldSuppressBuiltInModel>
): ReturnType<BuildShouldSuppressBuiltInModel> {
  return buildShouldSuppressBuiltInModelImpl(...args);
}
