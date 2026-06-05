// Manual facade. Keep loader boundary explicit.
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  CLAUDE_CLI_BACKEND_ID: string;
  isClaudeCliProvider: (providerId: string) => boolean;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "anthropic",
    artifactBasename: "api.js",
  });
}
/** Anthropic plugin backend id for Claude CLI provider detection. */
export const CLAUDE_CLI_BACKEND_ID: FacadeModule["CLAUDE_CLI_BACKEND_ID"] =
  loadFacadeModule()["CLAUDE_CLI_BACKEND_ID"];
/** Returns whether a provider id belongs to the Claude CLI backend family. */
export const isClaudeCliProvider: FacadeModule["isClaudeCliProvider"] = ((...args) =>
  loadFacadeModule()["isClaudeCliProvider"](...args)) as FacadeModule["isClaudeCliProvider"];
