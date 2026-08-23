import type { AgentConfig, AgentEntryConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function stripInheritedAgentLocation(entry: AgentConfig): AgentConfig;
function stripInheritedAgentLocation(entry: AgentEntryConfig): AgentEntryConfig;
function stripInheritedAgentLocation(
  entry: AgentConfig | AgentEntryConfig,
): AgentConfig | AgentEntryConfig {
  const { agentDir: _agentDir, runtime, ...rest } = entry;
  if (runtime?.type !== "acp" || runtime.acp?.cwd === undefined) {
    return { ...rest, ...(runtime ? { runtime } : {}) };
  }
  const { cwd: _cwd, ...acp } = runtime.acp;
  return { ...rest, runtime: { ...runtime, acp } };
}

/** Drops persistent locations that an isolated one-shot run cannot own. */
export function stripInheritedAgentLocations(base: OpenClawConfig): OpenClawConfig {
  const { session, ...root } = base;
  const { store: _store, ...sessionWithoutStore } = session ?? {};
  const withoutSessionStore = session ? { ...root, session: sessionWithoutStore } : base;
  const agents = withoutSessionStore.agents;
  if (!agents) {
    return withoutSessionStore;
  }
  const entries = agents.entries;
  const list = agents.list;
  const roster =
    entries !== undefined
      ? {
          entries: Object.fromEntries(
            Object.entries(entries).map(([id, entry]) => [id, stripInheritedAgentLocation(entry)]),
          ),
        }
      : list !== undefined
        ? { list: list.map((entry) => stripInheritedAgentLocation(entry)) }
        : undefined;
  if (!roster) {
    return withoutSessionStore;
  }
  return {
    ...withoutSessionStore,
    agents: { ...agents, ...roster },
  };
}
