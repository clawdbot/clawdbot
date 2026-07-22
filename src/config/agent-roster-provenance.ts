import { isRecord } from "../utils.js";
import { INCLUDE_KEY } from "./includes.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function hasAuthoredRoster(snapshot: ConfigFileSnapshot): boolean {
  const agents = isRecord(snapshot.parsed) ? snapshot.parsed.agents : undefined;
  return isRecord(agents) && Object.hasOwn(agents, "list");
}

/** Whether include/env resolution produced a non-empty roster before raw migrations. */
export function hasResolvedRosterBeforeMigrations(snapshot: ConfigFileSnapshot): boolean {
  const list = snapshot.sourceConfigBeforeMigrations?.agents?.list;
  return Array.isArray(list) && list.length > 0;
}

/** Whether an include, rather than the authored root, owns agents.list. */
export function configIncludeOwnsAgentRoster(snapshot: ConfigFileSnapshot): boolean {
  if (
    hasAuthoredRoster(snapshot) ||
    !Array.isArray(snapshot.sourceConfigBeforeMigrations?.agents?.list)
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
