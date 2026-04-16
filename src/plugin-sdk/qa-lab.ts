// Manual facade. Keep loader boundary explicit.
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  isQaLabCliAvailable: () => boolean;
  registerQaLabCli: (program: unknown) => void;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "qa-lab",
    artifactBasename: "cli.js",
  });
}

function isMissingQaLabFacadeError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message === "Unable to resolve bundled plugin public surface qa-lab/cli.js" ||
    err.message.startsWith("Unable to open bundled plugin public surface ")
  );
}

export const registerQaLabCli: FacadeModule["registerQaLabCli"] = ((...args) =>
  loadFacadeModule().registerQaLabCli(...args)) as FacadeModule["registerQaLabCli"];

export const isQaLabCliAvailable: FacadeModule["isQaLabCliAvailable"] = (() => {
  try {
    return loadFacadeModule().isQaLabCliAvailable();
  } catch (err) {
    if (isMissingQaLabFacadeError(err)) {
      return false;
    }
    throw err;
  }
}) as FacadeModule["isQaLabCliAvailable"];
