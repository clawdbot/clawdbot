import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";
import type { ClawdbotConfig } from "./types.js";

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

function collectReferencedAgentIds(cfg: ClawdbotConfig): string[] {
  const ids = new Set<string>();

  const defaultAgentId =
    cfg.routing?.defaultAgentId?.trim() || DEFAULT_AGENT_ID;
  ids.add(normalizeAgentId(defaultAgentId));

  const agents = cfg.routing?.agents;
  if (agents && typeof agents === "object") {
    for (const id of Object.keys(agents)) {
      ids.add(normalizeAgentId(id));
    }
  }

  const bindings = cfg.routing?.bindings;
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
  cfg: ClawdbotConfig,
  agentId: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): string {
  const id = normalizeAgentId(agentId);
  const configured = cfg.routing?.agents?.[id]?.agentDir?.trim();
  if (configured) return resolveUserPath(configured);
  const root = resolveStateDir(
    deps?.env ?? process.env,
    deps?.homedir ?? os.homedir,
  );
  return path.join(root, "agents", id, "agent");
}

export function findDuplicateAgentDirs(
  cfg: ClawdbotConfig,
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

export function formatDuplicateAgentDirError(
  dups: DuplicateAgentDir[],
): string {
  const lines: string[] = [
    "Duplicate agentDir detected (multi-agent config).",
    "Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
    "",
    "Conflicts:",
    ...dups.map(
      (d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`,
    ),
    "",
    "Fix: remove the shared routing.agents.*.agentDir override (or give each agent its own directory).",
    "If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.",
  ];
  return lines.join("\n");
}
