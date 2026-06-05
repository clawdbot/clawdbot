/**
 * Memory config types shared by core context-engine paths and memory host/plugin runtimes.
 * Builtin memory stays core-owned; qmd settings describe the external QMD integration.
 */
import type { SessionSendPolicyConfig } from "./types.base.js";

/** Memory backend family selected for retrieval and session memory features. */
export type MemoryBackend = "builtin" | "qmd";
/** Citation rendering mode for memory-injected context. */
export type MemoryCitationsMode = "auto" | "on" | "off";
/** QMD search command flavor used for retrieval. */
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
/** QMD startup/update scheduling mode. */
export type MemoryQmdStartupMode = "off" | "idle" | "immediate";

/** Top-level memory config block. */
export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
};

/** QMD-specific memory backend config. */
export type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  rerank?: boolean;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

/** mcporter daemon integration for long-lived QMD MCP access. */
export type MemoryQmdMcporterConfig = {
  /**
   * Route QMD searches through mcporter (MCP runtime) instead of spawning `qmd` per query.
   * Requires:
   * - `mcporter` installed and on PATH
   * - A configured mcporter server that runs `qmd mcp` with `lifecycle: keep-alive`
   */
  enabled?: boolean;
  /** mcporter server name (defaults to "qmd") */
  serverName?: string;
  /** Start the mcporter daemon automatically (defaults to true when enabled). */
  startDaemon?: boolean;
};

/** Additional QMD index path entry. */
export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

/** Session export settings for QMD memory indexing. */
export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

/** Background update and embedding schedule for QMD memory. */
export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  startup?: MemoryQmdStartupMode;
  startupDelayMs?: number;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

/** Retrieval and injection limits for QMD memory results. */
export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
