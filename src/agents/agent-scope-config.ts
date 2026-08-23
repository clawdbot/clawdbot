/** Resolves configured agent ids, directories, workspaces, and merged agent defaults. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import { getRetainedLegacyDefaultAgentId } from "../config/legacy.default-agent-owner-state.js";
import { hasExplicitModelPolicyAllow } from "../config/model-policy-allowlist-migration.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
} from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { registerResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type AgentEntriesConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>;
type MutableAgentEntry = AgentEntry | AgentEntriesConfig[string];
type AgentRosterProperty = { kind: "entries" | "list"; value: unknown };
export type ListedAgentEntry = {
  entry: AgentEntry;
  source: { kind: "entries"; key: string } | { kind: "list"; index: number };
};

export type AgentSelectionContext = {
  surface: string;
  hint: string;
};

export class AgentSelectionRequiredError extends Error {
  readonly code = "AGENT_SELECTION_REQUIRED";
  readonly agentIds: string[];
  readonly surface: string;
  readonly hint: string;

  constructor(agentIds: string[], context?: AgentSelectionContext) {
    const surface = context?.surface ?? "this operation";
    const hint =
      context?.hint ??
      "Select an agent explicitly; CLI callers can pass --agent <id>, channels can add a binding, and ambient services can set their agentId target.";
    super(`Multiple agents are configured, but ${surface} has no explicit owner. ${hint}`);
    this.name = "AgentSelectionRequiredError";
    this.agentIds = agentIds;
    this.surface = surface;
    this.hint = hint;
  }
}

/** Per-agent config after applying agent defaults and normalizing scalar fields. */
export type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  models?: AgentEntry["models"];
  params?: AgentEntry["params"];
  runtime?: AgentEntry["runtime"];
  modelPolicy?: AgentEntry["modelPolicy"];
  agentRuntime?: AgentEntry["agentRuntime"];
  utilityModel?: AgentEntry["utilityModel"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
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
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.entries(roster.value).flatMap(([id, entry]) =>
      isRecord(entry)
        ? [
            {
              entry: { ...entry, id },
              source: { kind: "entries" as const, key: id },
            },
          ]
        : [],
    );
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
  const entries = (agents as Record<string, unknown>)["entries"];
  if (Object.hasOwn(agents, "entries") && entries !== undefined) {
    return { kind: "entries", value: entries };
  }
  const list = (agents as Record<string, unknown>)["list"];
  if (Object.hasOwn(agents, "list") && list !== undefined) {
    return { kind: "list", value: list };
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
  if (agents.length === 0 && !hasAgentRosterProperty(cfg)) {
    // Match resolveDefaultAgentId's Plugin SDK compatibility for raw pre-roster configs.
    return [LEGACY_IMPLICIT_AGENT_ID];
  }
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

/** Returns a configured agent id or throws the canonical CLI selection error. */
export function resolveConfiguredAgentId(cfg: OpenClawConfig, agentId: string): string {
  if (!listAgentIds(cfg).includes(agentId)) {
    // formatCliCommand, not a literal: under a profile or container the bare command is wrong,
    // so a hint that cannot be pasted back is worse than none.
    throw new Error(
      `Unknown agent id "${agentId}". Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  return agentId;
}

export function tryResolveSoleAgentId(cfg: OpenClawConfig): string | undefined {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    if (!hasAgentRosterProperty(cfg)) {
      return LEGACY_IMPLICIT_AGENT_ID;
    }
    return undefined;
  }
  return agents.length === 1 ? normalizeAgentId(agents[0]!.id) : undefined;
}

export function resolveSoleAgentId(cfg: OpenClawConfig, context?: AgentSelectionContext): string {
  const sole = tryResolveSoleAgentId(cfg);
  if (sole) {
    return sole;
  }
  const agentIds = listAgentIds(cfg);
  if (agentIds.length === 0) {
    throw new Error("No agents configured. Run `openclaw onboard` or `openclaw agents add` first.");
  }
  throw new AgentSelectionRequiredError(agentIds, context);
}

function tryResolveRawLegacyDefaultAgentId(cfg: OpenClawConfig): string | undefined {
  if (cfg.agents?.ownership === "explicit") {
    return undefined;
  }
  const marked = listAgentEntries(cfg).filter((entry) => entry.default === true);
  return marked.length === 1 ? normalizeAgentId(marked[0]!.id) : undefined;
}

/** Resolves sole/raw legacy owners plus the retained in-process migration owner. */
export function tryResolveLegacyCompatibilityAgentId(cfg: OpenClawConfig): string | undefined {
  const retainedAgentId = getRetainedLegacyDefaultAgentId(cfg);
  return retainedAgentId && listAgentIds(cfg).includes(retainedAgentId)
    ? retainedAgentId
    : tryResolveDefaultAgentId(cfg);
}

/** Resolves the owner for ambient system work and explicit requests. */
export function tryResolveAmbientOwnerAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
): string | undefined {
  const explicitAgentId =
    normalizeOptionalString(requestedAgentId) ??
    normalizeOptionalString(cfg.agents?.defaults?.systemAgent?.agentId);
  // The documented system-agent owner is explicit config, so it precedes a stripped legacy marker.
  return explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : tryResolveLegacyCompatibilityAgentId(cfg);
}

/** Ambient owner for surfaces that must fail loudly rather than act on the wrong agent. */
export function resolveAmbientOwnerAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
  context?: AgentSelectionContext,
): string {
  return tryResolveAmbientOwnerAgentId(cfg, requestedAgentId) ?? resolveSoleAgentId(cfg, context);
}

/** Resolves a CLI operation owner while preserving legacy default markers outside explicit fleets. */
export function resolveAgentOperationAgentId(
  cfg: OpenClawConfig,
  requestedAgentId?: string,
  context?: AgentSelectionContext,
): string {
  if (requestedAgentId !== undefined || cfg.agents?.ownership === "explicit") {
    return resolveAmbientOwnerAgentId(cfg, requestedAgentId, context);
  }
  return tryResolveLegacyCompatibilityAgentId(cfg) ?? resolveDefaultAgentId(cfg, context);
}

/**
 * @deprecated Ambient system work uses resolveAmbientOwnerAgentId so the configured
 * system agent is honored; explicit-selection surfaces use resolveSoleAgentId. This
 * accepts raw shipped markers only for input compatibility.
 */
export function resolveDefaultAgentId(
  cfg: OpenClawConfig,
  context?: AgentSelectionContext,
): string {
  return tryResolveRawLegacyDefaultAgentId(cfg) ?? resolveSoleAgentId(cfg, context);
}

/** @deprecated Use tryResolveSoleAgentId; accepts raw shipped markers only for input compatibility. */
export function tryResolveDefaultAgentId(cfg: OpenClawConfig): string | undefined {
  return tryResolveRawLegacyDefaultAgentId(cfg) ?? tryResolveSoleAgentId(cfg);
}

export function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  // Point lookups are hot; the public list helper must clone every keyed entry.
  // Traverse the roster directly so a match does not project unrelated agents.
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    const entries = roster.value;
    for (const key in entries) {
      if (!Object.hasOwn(entries, key)) {
        continue;
      }
      const entry = entries[key];
      if (isRecord(entry) && normalizeAgentId(key) === id) {
        return { ...entry, id: key };
      }
    }
    return undefined;
  }
  if (roster?.kind === "list" && Array.isArray(roster.value)) {
    return (roster.value as AgentEntry[]).find(
      (entry) => entry !== null && typeof entry === "object" && normalizeAgentId(entry.id) === id,
    );
  }
  return undefined;
}

/** Resolves the authored entry object for in-place canonical config mutations. */
export function resolveMutableAgentEntry(
  cfg: OpenClawConfig,
  agentId: string,
): MutableAgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  const roster = readAgentRosterProperty(cfg);
  if (roster?.kind === "entries" && roster.value && typeof roster.value === "object") {
    const entries = roster.value as AgentEntriesConfig;
    const key = Object.keys(entries).find((candidate) => normalizeAgentId(candidate) === id);
    return key ? entries[key] : undefined;
  }
  if (roster?.kind === "list" && Array.isArray(roster.value)) {
    return (roster.value as AgentEntry[]).find((entry) => normalizeAgentId(entry?.id) === id);
  }
  return undefined;
}

/** Resolves merged config for one agent id. */
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry: AgentEntry | undefined =
    resolveAgentEntry(cfg, id) ??
    (!hasAgentRosterProperty(cfg) && id === LEGACY_IMPLICIT_AGENT_ID ? { id } : undefined);
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
    ...(entry.params ? { params: entry.params } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(hasExplicitModelPolicyAllow(entry.modelPolicy) ? { modelPolicy: entry.modelPolicy } : {}),
    ...(entry.agentRuntime ? { agentRuntime: entry.agentRuntime } : {}),
    utilityModel: readStringValue(entry.utilityModel),
    thinkingDefault: entry.thinkingDefault,
    verboseDefault: entry.verboseDefault ?? agentDefaults?.verboseDefault,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault ?? agentDefaults?.fastModeDefault,
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

function tryResolveInheritedWorkspaceAgentId(cfg: OpenClawConfig): string | undefined {
  return tryResolveLegacyCompatibilityAgentId(cfg);
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
  // Read-time migration removes default:true before write-time workspace pinning can run.
  const inheritedWorkspaceAgentId = tryResolveInheritedWorkspaceAgentId(cfg);
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (inheritedWorkspaceAgentId && id === inheritedWorkspaceAgentId) {
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

export function tryResolveConfiguredAgentWorkspaceDir(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inheritedWorkspaceAgentId = tryResolveInheritedWorkspaceAgentId(cfg);
  if (inheritedWorkspaceAgentId) {
    return resolveAgentWorkspaceDir(cfg, inheritedWorkspaceAgentId, env);
  }
  const configured = cfg.agents?.defaults?.workspace?.trim();
  return configured ? stripNullBytes(resolveUserPath(configured, env)) : undefined;
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
  return resolveAgentDir(cfg, resolveAmbientOwnerAgentId(cfg), env);
}
