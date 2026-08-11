import {
  listAgentIds,
  readAgentRosterProperty,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
// Private runtime facade for the Memory Core doctor migration preview.
import type { OpenClawConfig } from "../config/types.js";
import { isValidAgentId } from "../routing/session-key.js";

export type MemoryMigrationAgentWorkspace = Readonly<{
  agentId: string;
  sandboxed: boolean;
  workspaceDir: string;
}>;

export type MemoryMigrationAgentWorkspaces =
  | Readonly<{ kind: "invalid-agent" }>
  | Readonly<{ kind: "resolved"; agents: readonly MemoryMigrationAgentWorkspace[] }>;

function rawRosterAgentIds(config: OpenClawConfig): string[] {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind === "entries" && roster.value && typeof roster.value === "object") {
    return Object.keys(roster.value);
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry) => {
    const agentId = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    return typeof agentId === "string" ? [agentId] : [];
  });
}

/**
 * Resolves the whole roster before a migration preview touches agent-owned paths.
 * Keep this private because roster precedence and workspace layout are host policy,
 * not a general plugin contract.
 */
export function resolveMemoryMigrationAgentWorkspaces(
  config: OpenClawConfig,
): MemoryMigrationAgentWorkspaces {
  if (rawRosterAgentIds(config).some((agentId) => !isValidAgentId(agentId))) {
    return { kind: "invalid-agent" };
  }
  try {
    return {
      kind: "resolved",
      agents: listAgentIds(config).map((agentId) => ({
        agentId,
        sandboxed: resolveAgentConfig(config, agentId)?.sandbox?.mode === "all",
        workspaceDir: resolveAgentWorkspaceDir(config, agentId),
      })),
    };
  } catch {
    return { kind: "invalid-agent" };
  }
}
