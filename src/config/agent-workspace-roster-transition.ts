import {
  listAgentEntries,
  resolveAgentWorkspaceDir,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function pinSurvivorWorkspaceForRosterCollapse(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): { config: OpenClawConfig; insertedPaths: string[][] } {
  const sourceEntries = listAgentEntries(sourceConfig);
  const targetEntries = listAgentEntries(targetConfig);
  if (sourceEntries.length <= 1 || targetEntries.length !== 1) {
    return { config: targetConfig, insertedPaths: [] };
  }

  const survivorId = normalizeAgentId(targetEntries[0]!.id);
  if (!sourceEntries.some((entry) => normalizeAgentId(entry.id) === survivorId)) {
    return { config: targetConfig, insertedPaths: [] };
  }

  const targetAgents = targetConfig.agents ?? {};
  const entries = targetAgents.entries
    ? { ...targetAgents.entries }
    : toAgentEntriesRecord(targetEntries);
  const entryKey = Object.keys(entries).find(
    (candidate) => normalizeAgentId(candidate) === survivorId,
  );
  const entry = entryKey ? entries[entryKey] : undefined;
  const workspaceNeedsPin =
    entry !== undefined &&
    (!Object.hasOwn(entry, "workspace") ||
      (typeof entry.workspace === "string" && entry.workspace.trim().length === 0));
  if (!entryKey || !entry || !workspaceNeedsPin) {
    return { config: targetConfig, insertedPaths: [] };
  }

  // Resolve against the old multi-agent topology before sole-agent inheritance
  // can move the survivor from its per-agent workspace to the shared root.
  entries[entryKey] = {
    ...entry,
    workspace: resolveAgentWorkspaceDir(sourceConfig, survivorId, env),
  };
  const { list: _legacyList, ...canonicalAgents } = targetAgents;
  return {
    config: {
      ...targetConfig,
      agents: { ...canonicalAgents, entries },
    },
    insertedPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
