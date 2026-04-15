import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};

function isMissingQaRuntimeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Unable to resolve bundled plugin public surface qa-lab/runtime-api.js" ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

export function loadQaRuntimeModule(): QaRuntimeSurface {
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: "qa-lab",
    artifactBasename: "runtime-api.js",
  });
}

export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}
