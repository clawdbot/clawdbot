import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Maps a reload's changed paths to the affected agent ids, or undefined when the change is broader
 * than a bounded set of agents. Only paths under `agents.entries.<id>.*` scope the prepared-model
 * runtime refresh to those agents; any more global config change (models, defaults, plugins, ...)
 * reports undefined so every configured owner is rebuilt as today.
 *
 * Machine-managed metadata paths (e.g. `meta.*`) are scope-neutral: they are filtered out before
 * the agent-scope decision so they never disable agent-scoped reloads.
 *
 * Whole-entry additions of a non-default agent are safe to scope: the added agent does not affect
 * the default-agent-derived `inheritedAuthDir` shared by every configured owner. Adding a
 * `default: true` agent, removing any agent (the removed agent's default status cannot be verified
 * from the next config alone), or changing an agent's `default` marker or `agentDir` all affect
 * `inheritedAuthDir`, so they force a full refresh (undefined).
 */
export function resolveModelRuntimeAgentScopeIdsFromChangedPaths(
  changedPaths: readonly string[],
  nextConfig: OpenClawConfig,
): ReadonlySet<string> | undefined {
  if (changedPaths.length === 0) {
    return undefined;
  }
  const agentIds = new Set<string>();
  for (const path of changedPaths) {
    if (path === "meta" || path.startsWith("meta.")) {
      continue;
    }
    const match = /^agents\.entries\.([^.]+)(?:\.|$)/.exec(path);
    if (!match) {
      return undefined;
    }
    const field = path.slice(`agents.entries.${match[1]}`.length + 1);
    // Changes to an agent's `default` marker or `agentDir` affect the
    // default-agent-derived `inheritedAuthDir` shared by every configured owner,
    // so they force a full refresh (undefined).
    if (field === "default" || field === "agentDir" || field.startsWith("agentDir.")) {
      return undefined;
    }
    if (field === "") {
      // Whole-entry change. Adding a non-default agent is safe to scope because
      // the default-agent-derived `inheritedAuthDir` is unchanged. Adding a
      // `default: true` agent or removing any agent (the removed agent's default
      // status cannot be verified from the next config alone) may reshape the
      // shared `inheritedAuthDir`, so fall back to a full refresh.
      const entry = resolveAgentEntry(nextConfig, match[1]!);
      if (entry && entry.default !== true) {
        agentIds.add(normalizeAgentId(match[1]!));
        continue;
      }
      return undefined;
    }
    agentIds.add(normalizeAgentId(match[1]!));
  }
  return agentIds.size > 0 ? agentIds : undefined;
}
