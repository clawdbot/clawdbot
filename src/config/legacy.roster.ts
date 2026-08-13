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

export function migratePersistedImplicitMainRoster(raw: unknown): MigrationResult {
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
    if (!Array.isArray(rosterProperty.value)) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    const legacyList = rosterProperty.value;
    if (legacyList.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    const legacyIds = new Set<string>();
    const legacyOrder: string[] = [];
    for (const value of legacyList) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.trim() !== entry.id || !entry.id) {
        return { config: raw, changed: false, diagnostics: [] };
      }
      const normalizedId = normalizeAgentId(entry.id);
      if (normalizedId !== entry.id || legacyIds.has(normalizedId)) {
        return { config: raw, changed: false, diagnostics: [] };
      }
      legacyIds.add(normalizedId);
      legacyOrder.push(entry.id);
    }
    legacyRosterOrder = legacyOrder;
    const entries = Object.fromEntries(
      legacyList.map((value) => {
        const entry = value as Record<string, unknown>;
        const { id, ...config } = entry;
        return [id as string, config];
      }),
    );
    const { list: _list, ...rest } = agents;
    agents = { ...rest, entries };
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
