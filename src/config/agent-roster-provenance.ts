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

function hasAncestorRosterInclude(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    (Object.hasOwn(raw, INCLUDE_KEY) ||
      (isRecord(raw.agents) && Object.hasOwn(raw.agents, INCLUDE_KEY)))
  );
}

/** Whether include/env resolution produced a non-empty roster before raw migrations. */
export function hasResolvedRosterBeforeMigrations(snapshot: ConfigFileSnapshot): boolean {
  return listAgentEntries(snapshot.sourceConfigBeforeMigrations ?? {}).length > 0;
}

/** Whether an include, rather than the authored root, owns agents.entries. */
export function configIncludeOwnsAgentRosterValues(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: unknown;
}): boolean {
  const resolved = params.sourceConfigBeforeMigrations;
  if (!hasAgentRosterProperty(resolved)) {
    return false;
  }
  const authoredRoster = readRosterValue(params.parsed);
  if (containsIncludeDirective(authoredRoster)) {
    return true;
  }
  if (!hasAncestorRosterInclude(params.parsed)) {
    return false;
  }
  // Shape comparison cannot prove that an ancestor include contributed nothing:
  // an included entry may be byte-identical to the local one. Treat that
  // ambiguity as include ownership so later writes cannot flatten or delete it.
  return true;
}

/** Whether an include, rather than the authored root, owns agents.entries. */
export function configIncludeOwnsAgentRoster(snapshot: ConfigFileSnapshot): boolean {
  return configIncludeOwnsAgentRosterValues({
    parsed: snapshot.parsed,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
  });
}
