import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MigrationResult = {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
  insertedPaths?: string[][];
  retainedLegacyDefaultAgentId?: string;
};

/** Converts a valid legacy roster without applying ownership or runtime migrations. */
export function parseLegacyAgentRoster(
  value: unknown,
): { entries: Record<string, unknown>; order: string[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = new Set<string>();
  const entries: [string, Record<string, unknown>][] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const { id, ...config } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() !== id || !id) {
      return undefined;
    }
    const normalizedId = normalizeAgentId(id);
    if (normalizedId !== id || ids.has(normalizedId)) {
      return undefined;
    }
    ids.add(id);
    entries.push([id, config]);
  }
  return { entries: Object.fromEntries(entries), order: [...ids] };
}

export function migratePersistedImplicitMainRoster(
  raw: unknown,
  options: { materializeWorkspace?: boolean } = {},
): MigrationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const root = raw as Record<string, unknown>;
  if (
    Object.hasOwn(root, "agents") &&
    (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents))
  ) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  let agents =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : {};
  let convertedLegacyList = false;
  let legacyRosterOrder: string[] | undefined;
  let rosterProperty = readAgentRosterProperty({ ...root, agents });
  if (rosterProperty?.kind === "list") {
    const roster = parseLegacyAgentRoster(rosterProperty.value);
    if (!roster) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    legacyRosterOrder = roster.order;
    const { list: _list, ...rest } = agents;
    agents = { ...rest, entries: roster.entries };
    convertedLegacyList = true;
    rosterProperty = readAgentRosterProperty({ ...root, agents });
  }
  const entries = rosterProperty?.kind === "entries" ? rosterProperty.value : undefined;
  if (
    !rosterProperty ||
    (entries &&
      typeof entries === "object" &&
      !Array.isArray(entries) &&
      Object.keys(entries).length === 0)
  ) {
    if (agents.ownership === "explicit") {
      return {
        config: convertedLegacyList ? { ...root, agents } : raw,
        changed: convertedLegacyList,
        diagnostics: convertedLegacyList ? ["Moved agents.list to keyed agents.entries."] : [],
      };
    }
    return {
      config: { ...root, agents: { ...agents, entries: { main: {} } } },
      changed: true,
      diagnostics: convertedLegacyList ? ["Moved agents.list to keyed agents.entries."] : [],
    };
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const roster = entries as Record<string, unknown>;
  const validIds =
    legacyRosterOrder ??
    Object.entries(roster).flatMap(([id, entry]) =>
      entry && typeof entry === "object" && !Array.isArray(entry) ? [id] : [],
    );
  if (validIds.length === 0) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const hasInvalidDefaultMarker = validIds.some((id) => {
    const entry = roster[id] as Record<string, unknown>;
    return Object.hasOwn(entry, "default") && typeof entry.default !== "boolean";
  });
  if (hasInvalidDefaultMarker) {
    return { config: raw, changed: false, diagnostics: [] };
  }

  const markedIds = validIds.filter(
    (id) => (roster[id] as Record<string, unknown>).default === true,
  );
  const hasValidLegacyMarker = agents.ownership !== "explicit" && markedIds.length === 1;
  const legacyDefaultAgentId =
    tryGetLegacyDefaultAgentId(raw as OpenClawConfig) ??
    (validIds.length > 1 && hasValidLegacyMarker ? markedIds[0] : undefined);
  let nextRoot: Record<string, unknown> = { ...root, agents };
  let insertedPaths: string[][] = [];
  const diagnostics = convertedLegacyList ? ["Moved agents.list to keyed agents.entries."] : [];
  let changed = convertedLegacyList;
  if (legacyDefaultAgentId) {
    const materialized = materializeLegacyDefaultAgentRoles(
      nextRoot as OpenClawConfig,
      legacyDefaultAgentId,
      options,
    );
    nextRoot = materialized.config as Record<string, unknown>;
    insertedPaths = materialized.insertedPaths;
    if (insertedPaths.length > 0) {
      diagnostics.push("Materialized legacy per-surface agent ownership.");
      changed = true;
    }
  }
  if (hasValidLegacyMarker) {
    const nextAgents = (nextRoot.agents as Record<string, unknown> | undefined) ?? agents;
    const materializedEntries = (nextAgents.entries ?? roster) as Record<string, unknown>;
    nextRoot = {
      ...nextRoot,
      agents: {
        ...nextAgents,
        entries: Object.fromEntries(
          Object.entries(materializedEntries).map(([id, entry]) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [id, entry];
            }
            const { default: _default, ...rest } = entry as Record<string, unknown>;
            return [id, rest];
          }),
        ),
      },
    };
    diagnostics.push("Removed retired agents.entries.*.default markers.");
    changed = true;
  }

  const config = (changed ? nextRoot : raw) as OpenClawConfig;
  retainLegacyDefaultAgentId(config, legacyDefaultAgentId);
  return {
    config,
    changed,
    diagnostics,
    ...(insertedPaths.length > 0 ? { insertedPaths } : {}),
    ...(legacyDefaultAgentId ? { retainedLegacyDefaultAgentId: legacyDefaultAgentId } : {}),
  };
}
