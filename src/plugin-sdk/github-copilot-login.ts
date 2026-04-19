// Manual facade. Keep loader boundary explicit.
import type { RuntimeEnv } from "../runtime.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  githubCopilotLoginCommand: (
    opts: { profileId?: string; yes?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<void>;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "github-copilot",
    artifactBasename: "api.js",
  });
}
export const githubCopilotLoginCommand: FacadeModule["githubCopilotLoginCommand"] = ((...args) =>
  loadFacadeModule()["githubCopilotLoginCommand"](
    ...args,
  )) as FacadeModule["githubCopilotLoginCommand"];
