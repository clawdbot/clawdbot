/** Resolves configured agent ids, directories, workspaces, and merged agent defaults. */
import path from "node:path";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { hasExplicitModelPolicyAllow } from "../config/model-policy-allowlist-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
} from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { registerResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

export type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type AgentEntriesConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>;
export type AgentRosterProperty = { kind: "entries" | "list"; value: unknown };
export type ListedAgentEntry = {
  entry: AgentEntry;
  source: { kind: "entries"; key: string } | { kind: "list"; index: number };
};

/** Per-agent config after applying agent defaults and normalizing scalar fields. */
export type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  models?: AgentEntry["models"];
  modelPolicy?: AgentEntry["modelPolicy"];
  utilityModel?: AgentEntry["utilityModel"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
  contextTokens?: AgentEntry["contextTokens"];
  contextInjection?: AgentEntry["contextInjection"];
  bootstrapMaxChars?: AgentEntry["bootstrapMaxChars"];
  bootstrapTotalMaxChars?: AgentEntry["bootstrapTotalMaxChars"];
  experimental?: AgentDefaultsConfig["experimental"];
  skills?: AgentEntry["skills"];
  memory?: AgentEntry["memory"];
  humanDelay?: AgentEntry["humanDelay"];
  typingMode?: AgentEntry["typingMode"];
  tts?: AgentEntry["tts"];
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  embeddedAgent?: AgentEntry["embeddedAgent"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  return s.replaceAll("\0", "");
}

/** Lists valid configured agent entries from config. */
export function listAgentEntriesWithSource(cfg: OpenClawConfig): ListedAgentEntry[] {
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && roster.value && typeof roster.value === "object") {
    return Object.entries(roster.value).map(([id, entry]) => ({
      entry: Object.assign({ id }, entry),
      source: { kind: "entries", key: id },
    }));
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry, index) =>
    entry !== null && typeof entry === "object"
      ? [{ entry: entry as AgentEntry, source: { kind: "list" as const, index } }]
      : [],
  );
}

/** Lists valid configured agent entries from either supported representation. */
export function listAgentEntries(cfg: OpenClawConfig): AgentEntry[] {
  return listAgentEntriesWithSource(cfg).map(({ entry }) => entry);
}

/** Converts either supported roster representation into the canonical keyed shape. */
export function toAgentEntriesRecord(entries: readonly AgentEntry[]): AgentEntriesConfig {
  return Object.fromEntries(
    entries.map((entry) => {
      const { id, ...config } = entry;
      return [id, config];
    }),
  );
}

/** Reads the explicitly owned raw roster without normalizing malformed values. */
export function readAgentRosterProperty(raw: unknown): AgentRosterProperty | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const agents = (raw as { agents?: unknown }).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return undefined;
  }
  if (Object.hasOwn(agents, "entries")) {
    return { kind: "entries", value: (agents as Record<string, unknown>)["entries"] };
  }
  if (Object.hasOwn(agents, "list")) {
    return { kind: "list", value: (agents as Record<string, unknown>)["list"] };
  }
  return undefined;
}

/** True when raw config explicitly owns either supported roster representation. */
export function hasAgentRosterProperty(raw: unknown): boolean {
  return readAgentRosterProperty(raw) !== undefined;
}

/** Lists unique configured agent ids. */
export function listAgentIds(cfg: OpenClawConfig): string[] {
  const agents = listAgentEntries(cfg);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Resolves the sole configured default agent id. */
export function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    throw new Error("No agents configured. Run `openclaw onboard` or `openclaw agents add` first.");
  }
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length !== 1) {
    throw new Error(
      `Invalid agent roster: expected exactly one default=true entry, found ${defaults.length}. Run \`openclaw doctor --fix\`.`,
    );
  }
  return normalizeAgentId(defaults[0]!.id);
}

export function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

/** Resolves merged config for one agent id. */
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) {
    return undefined;
  }
  const agentDefaults = cfg.agents?.defaults;
  return {
    name: readStringValue(entry.name),
    workspace: readStringValue(entry.workspace),
    agentDir: readStringValue(entry.agentDir),
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    ...(entry.models ? { models: entry.models } : {}),
    ...(hasExplicitModelPolicyAllow(entry.modelPolicy) ? { modelPolicy: entry.modelPolicy } : {}),
    utilityModel: readStringValue(entry.utilityModel),
    thinkingDefault: entry.thinkingDefault,
    verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault ?? agentDefaults?.fastModeDefault,
    contextTokens: entry.contextTokens ?? agentDefaults?.contextTokens,
    contextInjection: entry.contextInjection,
    bootstrapMaxChars: entry.bootstrapMaxChars,
    bootstrapTotalMaxChars: entry.bootstrapTotalMaxChars,
    experimental:
      typeof entry.experimental === "object" && entry.experimental
        ? { ...agentDefaults?.experimental, ...entry.experimental }
        : agentDefaults?.experimental,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    memory: entry.memory,
    humanDelay: entry.humanDelay,
    typingMode: entry.typingMode ?? agentDefaults?.typingMode,
    tts: entry.tts,
    contextLimits:
      typeof entry.contextLimits === "object" && entry.contextLimits
        ? { ...agentDefaults?.contextLimits, ...entry.contextLimits }
        : agentDefaults?.contextLimits,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    embeddedAgent:
      typeof entry.embeddedAgent === "object" && entry.embeddedAgent
        ? entry.embeddedAgent
        : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentContextLimits(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): AgentContextLimitsConfig | undefined {
  const defaults = cfg?.agents?.defaults?.contextLimits;
  if (!cfg || !agentId) {
    return defaults;
  }
  return resolveAgentConfig(cfg, agentId)?.contextLimits ?? defaults;
}

export function resolveAgentWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveUserPath(configured, env));
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (id === defaultAgentId) {
    if (fallback) {
      return stripNullBytes(resolveUserPath(fallback, env));
    }
    return stripNullBytes(resolveDefaultAgentWorkspaceDir(env));
  }
  if (fallback) {
    return stripNullBytes(path.join(resolveUserPath(fallback, env), id));
  }
  const stateDir = resolveStateDir(env);
  return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}

export function resolveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) {
    const agentDir = resolveUserPath(configured, env);
    registerResolvedAgentDir({ agentId: id, agentDir, env });
    return agentDir;
  }
  const root = resolveStateDir(env);
  const agentDir = path.join(root, "agents", id, "agent");
  registerResolvedAgentDir({ agentId: id, agentDir, env });
  return agentDir;
}

export function resolveDefaultAgentDir(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(cfg, resolveDefaultAgentId(cfg), env);
}
