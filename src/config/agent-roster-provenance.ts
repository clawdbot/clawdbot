import { hasAgentRosterProperty, listAgentEntries } from "../agents/agent-scope-config.js";
import { isRecord } from "../utils.js";
import { INCLUDE_KEY } from "./includes.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function hasAuthoredRoster(snapshot: ConfigFileSnapshot): boolean {
  return hasAgentRosterProperty(snapshot.parsed);
}

/** Whether include/env resolution produced a non-empty roster before raw migrations. */
export function hasResolvedRosterBeforeMigrations(snapshot: ConfigFileSnapshot): boolean {
  return listAgentEntries(snapshot.sourceConfigBeforeMigrations ?? {}).length > 0;
}

/** Whether an include, rather than the authored root, owns agents.entries. */
export function configIncludeOwnsAgentRoster(snapshot: ConfigFileSnapshot): boolean {
  if (
    hasAuthoredRoster(snapshot) ||
    !hasAgentRosterProperty(snapshot.sourceConfigBeforeMigrations)
  ) {
    return false;
  }
  if (!isRecord(snapshot.parsed)) {
    return false;
  }
  const agents = snapshot.parsed.agents;
  return (
    Object.hasOwn(snapshot.parsed, INCLUDE_KEY) ||
    (isRecord(agents) && Object.hasOwn(agents, INCLUDE_KEY))
  );
}
