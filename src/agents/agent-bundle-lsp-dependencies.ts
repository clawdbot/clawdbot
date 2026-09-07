/** Owns the process/config dependencies used by the bundled LSP runtime. */
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";
import { loadEmbeddedAgentLspConfig } from "./embedded-agent-lsp.js";

export type BundleLspRuntimeDependencies = {
  loadLspConfig: typeof loadEmbeddedAgentLspConfig;
  spawnServerProcess: typeof spawnLspServerProcess;
};

export const defaultBundleLspRuntimeDependencies: BundleLspRuntimeDependencies = {
  loadLspConfig: loadEmbeddedAgentLspConfig,
  spawnServerProcess: spawnLspServerProcess,
};
