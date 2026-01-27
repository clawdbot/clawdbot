import os from "node:os";
import path from "node:path";

import type { MoltbotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace.js";

export { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

type AgentEntry = NonNullable<NonNullable<MoltbotConfig["agents"]>["list"]>[number];

type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

let defaultAgentWarned = false;

function listAgents(cfg: MoltbotConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

export function listAgentIds(cfg: MoltbotConfig): string[] {
  const agents = listAgents(cfg);
  if (agents.length === 0) return [DEFAULT_AGENT_ID];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

export function resolveDefaultAgentId(cfg: MoltbotConfig): string {
  const agents = listAgents(cfg);
  if (agents.length === 0) return DEFAULT_AGENT_ID;
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    console.warn("Multiple agents marked default=true; using the first entry as default.");
  }
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveSessionAgentIds(params: { sessionKey?: string; config?: MoltbotConfig }): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId;
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: MoltbotConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

function resolveAgentEntry(cfg: MoltbotConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveAgentConfig(
  cfg: MoltbotConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) return undefined;
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    memorySearch: entry.memorySearch,
    humanDelay: entry.humanDelay,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentModelPrimary(cfg: MoltbotConfig, agentId: string): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  const primary = raw.primary?.trim();
  return primary || undefined;
}

export function resolveAgentModelFallbacksOverride(
  cfg: MoltbotConfig,
  agentId: string,
): string[] | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw || typeof raw === "string") return undefined;
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) return undefined;
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

export function resolveAgentWorkspaceDir(cfg: MoltbotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) return resolveUserPath(fallback);
    return DEFAULT_AGENT_WORKSPACE_DIR;
  }
  return path.join(os.homedir(), `clawd-${id}`);
}

export function resolveAgentDir(cfg: MoltbotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) return resolveUserPath(configured);
  const root = resolveStateDir(process.env, os.homedir);
  return path.join(root, "agents", id, "agent");
}
