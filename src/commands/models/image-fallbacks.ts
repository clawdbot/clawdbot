/** Commands for managing default image model fallbacks. */
import type { RuntimeEnv } from "../../runtime.js";
import {
  addFallbackCommand,
  clearFallbacksCommand,
  listFallbacksCommand,
  removeFallbackCommand,
} from "./fallbacks-shared.js";

/** Lists configured image model fallbacks. */
export async function modelsImageFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  return await listFallbacksCommand({ label: "Image fallbacks", key: "imageModel" }, opts, runtime);
}

/** Adds an image model fallback. */
export async function modelsImageFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await addFallbackCommand(
    { label: "Image fallbacks", key: "imageModel", logPrefix: "Image fallbacks" },
    modelRaw,
    runtime,
  );
}

/** Removes an image model fallback. */
export async function modelsImageFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await removeFallbackCommand(
    {
      label: "Image fallbacks",
      key: "imageModel",
      notFoundLabel: "Image fallback",
      logPrefix: "Image fallbacks",
    },
    modelRaw,
    runtime,
  );
}

/** Clears all image model fallbacks. */
export async function modelsImageFallbacksClearCommand(runtime: RuntimeEnv) {
  return await clearFallbacksCommand(
    { key: "imageModel", clearedMessage: "Image fallback list cleared." },
    runtime,
  );
}
