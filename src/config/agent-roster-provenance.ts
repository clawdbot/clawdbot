import { hasAgentRosterProperty, listAgentEntries } from "../agents/agent-scope-config.js";
import { isRecord } from "../utils.js";
import { INCLUDE_KEY } from "./includes.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function rosterEntryBoundaryContainsInclude(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, INCLUDE_KEY)) {
    return true;
  }
  return [value.id, value.default].some(
    (field) => isRecord(field) && Object.hasOwn(field, INCLUDE_KEY),
  );
}

function authoredRosterBoundaryContainsInclude(value: unknown): boolean {
  if (isRecord(value) && Object.hasOwn(value, INCLUDE_KEY)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(rosterEntryBoundaryContainsInclude);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some(rosterEntryBoundaryContainsInclude);
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

/**
 * Roster include ownership decision table:
 * - Include-owned: an include contributes membership or default metadata at agents.entries/list,
 *   an entry object, an id/default field, a nested entries/list $include, or an ambiguous
 *   byte-identical roster contribution.
 * - Locally owned: ancestor includes contribute only unrelated config, or an include is nested
 *   inside entry-internal identity/model/etc. fields that cannot change membership or default;
 *   canonical roster writes preserve those entry-internal authored include nodes in place.
 */
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
  if (event.path[0] !== "agents") {
    return false;
  }
  if (event.path[1] === "entries") {
    return event.path.length <= 3 || event.path[3] === "default";
  }
  if (event.path[1] === "list") {
    // IncludeProcessor keeps array items at the list's logical owner path: an
    // item include is agents.list, while its id/default fields occupy path[2].
    return event.path.length <= 2 || event.path[2] === "id" || event.path[2] === "default";
  }
  return false;
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
  if (authoredRosterBoundaryContainsInclude(authoredRoster)) {
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
