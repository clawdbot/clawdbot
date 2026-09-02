/** Owns the process/config dependencies used by the bundled LSP runtime. */
import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../process/kill-tree.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";
import { loadEmbeddedAgentLspConfig } from "./embedded-agent-lsp.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

export type BundleLspRuntimeDependencies = {
  loadLspConfig: typeof loadEmbeddedAgentLspConfig;
  spawnServerProcess: (config: StdioMcpServerLaunchConfig) => ChildProcess;
  killProcessTree: typeof killProcessTree;
};

export const defaultBundleLspRuntimeDependencies: BundleLspRuntimeDependencies = {
  loadLspConfig: loadEmbeddedAgentLspConfig,
  spawnServerProcess: spawnLspServerProcess,
  killProcessTree,
};
