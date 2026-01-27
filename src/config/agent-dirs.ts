import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";
import type { MoltbotConfig } from "./types.js";

export type DuplicateAgentDir = {
  agentDir: string;
  agentIds: string[];
};

export class DuplicateAgentDirError extends Error {
  readonly duplicates: DuplicateAgentDir[];

  constructor(duplicates: DuplicateAgentDir[]) {
    super(formatDuplicateAgentDirError(duplicates));
    this.name = "DuplicateAgentDirError";
    this.duplicates = duplicates;
  }
}

function canonicalizeAgentDir(agentDir: string): string {
  const resolved = path.resolve(agentDir);
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function collectReferencedAgentIds(cfg: MoltbotConfig): string[] {
  const ids = new Set<string>();

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  ids.add(normalizeAgentId(defaultAgentId));

  for (const entry of agents) {
    if (entry?.id) ids.add(normalizeAgentId(entry.id));
  }

  const bindings = cfg.bindings;
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      const id = binding?.agentId;
      if (typeof id === "string" && id.trim()) {
        ids.add(normalizeAgentId(id));
      }
    }
  }

  return [...ids];
}

function resolveEffectiveAgentDir(
  cfg: MoltbotConfig,
  agentId: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): string {
  const id = normalizeAgentId(agentId);
  const configured = Array.isArray(cfg.agents?.list)
    ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir
    : undefined;
  const trimmed = configured?.trim();
  if (trimmed) return resolveUserPath(trimmed);
  const root = resolveStateDir(deps?.env ?? process.env, deps?.homedir ?? os.homedir);
  return path.join(root, "agents", id, "agent");
}

export function findDuplicateAgentDirs(
  cfg: MoltbotConfig,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): DuplicateAgentDir[] {
  const byDir = new Map<string, { agentDir: string; agentIds: string[] }>();

  for (const agentId of collectReferencedAgentIds(cfg)) {
    const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
    const key = canonicalizeAgentDir(agentDir);
    const entry = byDir.get(key);
    if (entry) {
      entry.agentIds.push(agentId);
    } else {
      byDir.set(key, { agentDir, agentIds: [agentId] });
    }
  }

  return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}

export function formatDuplicateAgentDirError(dups: DuplicateAgentDir[]): string {
  const lines: string[] = [
    "Duplicate agentDir detected (multi-agent config).",
    "Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
    "",
    "Conflicts:",
    ...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
    "",
    "Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).",
    "If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.",
  ];
  return lines.join("\n");
}
