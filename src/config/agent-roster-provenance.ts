import { hasAgentRosterProperty, listAgentEntries } from "../agents/agent-scope-config.js";
import { isRecord } from "../utils.js";
import { INCLUDE_KEY } from "./includes.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function containsIncludeDirective(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsIncludeDirective);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.hasOwn(value, INCLUDE_KEY) || Object.values(value).some(containsIncludeDirective);
}

function readRosterValue(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return undefined;
  }
  if (Object.hasOwn(raw.agents, "entries")) {
    return raw.agents.entries;
  }
  return Object.hasOwn(raw.agents, "list") ? raw.agents.list : undefined;
}

export function includeContributionOwnsAgentRoster(event: {
  path: readonly string[];
  value: unknown;
}): boolean {
  if (event.path.length === 0) {
    return hasAgentRosterProperty(event.value);
  }
  if (event.path.length === 1 && event.path[0] === "agents") {
    return (
      isRecord(event.value) &&
      (Object.hasOwn(event.value, "entries") || Object.hasOwn(event.value, "list"))
    );
  }
  return event.path[0] === "agents" && (event.path[1] === "entries" || event.path[1] === "list");
}

/** Whether include/env resolution produced a non-empty roster before raw migrations. */
export function hasResolvedRosterBeforeMigrations(snapshot: ConfigFileSnapshot): boolean {
  return listAgentEntries(snapshot.sourceConfigBeforeMigrations ?? {}).length > 0;
}

/** Whether an include, rather than the authored root, owns agents.entries. */
export function configIncludeOwnsAgentRosterValues(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: unknown;
  includeContributesRoster?: boolean;
}): boolean {
  const resolved = params.sourceConfigBeforeMigrations;
  if (!hasAgentRosterProperty(resolved)) {
    return false;
  }
  const authoredRoster = readRosterValue(params.parsed);
  if (containsIncludeDirective(authoredRoster)) {
    return true;
  }
  return params.includeContributesRoster === true;
}

/** Whether an include, rather than the authored root, owns agents.entries. */
export function configIncludeOwnsAgentRoster(snapshot: ConfigFileSnapshot): boolean {
  return configIncludeOwnsAgentRosterValues({
    parsed: snapshot.parsed,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
    includeContributesRoster: snapshot.includeProvenance?.agentRoster,
  });
}
