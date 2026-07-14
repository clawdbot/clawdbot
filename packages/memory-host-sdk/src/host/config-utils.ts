// Memory Host SDK helper module supports config utils behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
export { normalizeAgentId };
export { splitShellArgs } from "./openclaw-runtime-io.js";

// Shared OpenClaw config helpers used by memory host, QMD, and agent context code.

/** Chat shape used by memory send-policy matching. */
type ChatType = "direct" | "group" | "channel";
/** Memory backend selected by user config. */
export type MemoryBackend = "builtin" | "qmd";
/** Citation injection behavior for memory search results. */
export type MemoryCitationsMode = "auto" | "on" | "off";
/** QMD command mode used for search calls. */
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
/** QMD startup policy for background indexing. */
export type MemoryQmdStartupMode = "off" | "idle" | "immediate";

/** Action returned by a session send-policy rule. */
type SessionSendPolicyAction = "allow" | "deny";
/** Match criteria for one memory send-policy rule. */
type SessionSendPolicyMatch = {
  channel?: string;
  chatType?: ChatType;
  keyPrefix?: string;
  rawKeyPrefix?: string;
};
/** One ordered rule in session send-policy config. */
type SessionSendPolicyRule = {
  action: SessionSendPolicyAction;
  match?: SessionSendPolicyMatch;
};
/** Memory send-policy config with default action and ordered rules. */
export type SessionSendPolicyConfig = {
  default?: SessionSendPolicyAction;
  rules?: SessionSendPolicyRule[];
};

/** QMD collection path plus optional display name and glob pattern. */
export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

/** QMD mcporter daemon integration config. */
export type MemoryQmdMcporterConfig = {
  enabled?: boolean;
  serverName?: string;
  startDaemon?: boolean;
};

/** QMD session export config. */
type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

/** QMD update, debounce, startup, and timeout config. */
type MemoryQmdUpdateConfig = {
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

/** Search and injection limits for QMD memory results. */
type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

/** Full QMD-backed memory config. */
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

/** Top-level memory config shared by host and runtime callers. */
type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
};

/** Per-agent memory search enablement and extra collection paths. */
type MemorySearchConfig = {
  enabled?: boolean;
  extraPaths?: string[];
  qmd?: {
    extraCollections?: MemoryQmdIndexPath[];
  };
};

/** Agent context limits that bound memory file reads. */
type AgentContextLimitsConfig = {
  memoryGetMaxChars?: number;
  memoryGetDefaultLines?: number;
};

/** Secret reference accepted by provider header config. */
type SecretInput =
  | string
  | {
      source: string;
      provider: string;
      id: string;
    };

/** Agent-level config fields consumed by memory host helpers. */
type AgentConfig = {
  id?: string;
  default?: boolean;
  workspace?: string;
  memorySearch?: MemorySearchConfig;
  contextLimits?: AgentContextLimitsConfig;
};

/** Narrow OpenClaw config shape consumed by memory host utilities. */
export type OpenClawConfig = {
  agents?: {
    defaults?: {
      workspace?: string;
      memorySearch?: MemorySearchConfig;
      contextLimits?: AgentContextLimitsConfig;
    };
    list?: AgentConfig[];
  };
  memory?: MemoryConfig;
  models?: {
    providers?: Record<
      string,
      {
        api?: string;
        baseUrl?: string;
        headers?: Record<string, SecretInput>;
      }
    >;
  };
};

/** Root memory filename used in agent workspaces. */
export const MEMORY_HOST_ROOT_FILENAME = "MEMORY.md";

const DEFAULT_AGENT_ID = "main";
const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";
/** Treat shell-placeholder home values as absent. */
function normalizeHomeValue(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

/** Resolve the underlying OS home before applying OpenClaw-specific overrides. */
function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalizeHomeValue(env.HOME) ??
    normalizeHomeValue(env.USERPROFILE) ??
    normalizeHomeValue(homedir())
  );
}

/** Resolve OPENCLAW_HOME or the OS home, falling back to cwd for hermetic tests. */
function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const explicitHome = normalizeHomeValue(env.OPENCLAW_HOME);
  const rawHome = explicitHome
    ? explicitHome.replace(/^~(?=$|[\\/])/, resolveRawOsHomeDir(env, homedir) ?? "")
    : resolveRawOsHomeDir(env, homedir);
  return rawHome ? path.resolve(rawHome) : path.resolve(process.cwd());
}

/** Resolve standalone memory-host paths without importing core home-directory policy. */
export function resolveMemoryHostUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, resolveRequiredHomeDir(env, homedir)));
  }
  return path.resolve(trimmed);
}

/** Return legacy state roots in priority order. */
function legacyStateDirs(homedir: () => string): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

/** Resolve the current state root while preserving shipped legacy installs when present. */
function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveMemoryHostUserPath(override, env, homedir);
  }
  const effectiveHome = () => resolveRequiredHomeDir(env, homedir);
  const nextDir = path.join(effectiveHome(), NEW_STATE_DIRNAME);
  if (env.OPENCLAW_TEST_FAST === "1" || fs.existsSync(nextDir)) {
    return nextDir;
  }
  // Existing legacy state remains authoritative until an explicit migration creates .openclaw.
  const existingLegacy = legacyStateDirs(effectiveHome).find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  return existingLegacy ?? nextDir;
}

/** Resolve the default agent workspace, partitioned by OPENCLAW_PROFILE when set. */
function resolveDefaultAgentWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveRequiredHomeDir(env, os.homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && normalizeLowercaseStringOrEmpty(profile) !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

/** Return configured agent entries after dropping nullish placeholders. */
function listAgentEntries(cfg: OpenClawConfig): AgentConfig[] {
  return Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.filter((entry): entry is AgentConfig => Boolean(entry))
    : [];
}

/** Resolve the default agent id from explicit default marker or first agent entry. */
function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const chosen = (agents.find((agent) => agent.default) ?? agents[0])?.id;
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

/** Find one agent config by canonical id. */
function resolveAgentConfig(cfg: OpenClawConfig, agentId: string): AgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

/** Remove null bytes before paths are handed to filesystem APIs. */
function stripNullBytes(value: string): string {
  return value.replaceAll("\0", "");
}

/** Resolve the workspace directory for an agent id and config defaults. */
export function resolveMemoryHostAgentWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveMemoryHostUserPath(configured, env));
  }
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (id === resolveDefaultAgentId(cfg)) {
    return stripNullBytes(
      fallback ? resolveMemoryHostUserPath(fallback, env) : resolveDefaultAgentWorkspaceDir(env),
    );
  }
  if (fallback) {
    return stripNullBytes(path.join(resolveMemoryHostUserPath(fallback, env), id));
  }
  return stripNullBytes(path.join(resolveStateDir(env), `workspace-${id}`));
}

/** Resolve context limits for an agent with defaults fallback. */
export function resolveMemoryHostAgentContextLimits(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): AgentContextLimitsConfig | undefined {
  const defaults = cfg?.agents?.defaults?.contextLimits;
  if (!cfg || !agentId) {
    return defaults;
  }
  return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}

/** Resolve enabled memory search config plus deduplicated extra paths for an agent. */
export function resolveMemoryHostSearchPathConfig(
  cfg: OpenClawConfig,
  agentId: string,
): { enabled: boolean; extraPaths: string[] } | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  const rawPaths = normalizeStringEntries([
    ...(defaults?.extraPaths ?? []),
    ...(overrides?.extraPaths ?? []),
  ]);
  return {
    enabled,
    extraPaths: uniqueStrings(rawPaths),
  };
}
