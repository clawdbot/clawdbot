import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import {
  materializeLegacyDefaultAgentRoles,
  resolveLegacyFirstAgentWorkspacePin,
} from "./legacy.default-agent-roles.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MigrationResult = {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
  insertedPaths?: string[][];
  retainedLegacyDefaultAgentId?: string;
};

/** Keeps Doctor's allocated identities tied to their original authored list positions. */
export function projectLegacyAgentRosterEntries(list: unknown[]) {
  const entries: { sourceIndex: number; id: string; config: Record<string, unknown> }[] = [];
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const [sourceIndex, value] of list.entries()) {
    if (!isRecord(value)) {
      diagnostics.push(`Removed malformed agents.list[${sourceIndex}] entry.`);
      continue;
    }
    const rawId = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "agent";
    const requestedId = normalizeAgentId(rawId);
    if (requestedId !== rawId) {
      diagnostics.push(`Normalized agents.list id "${rawId}" → agents.entries.${requestedId}.`);
    }
    let id = requestedId;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${requestedId}-${suffix}`;
      suffix += 1;
    }
    const { id: _id, ...config } = value;
    entries.push({ sourceIndex, id, config });
    ids.add(id);
    if (id !== requestedId) {
      diagnostics.push(`Moved duplicate agents.list id "${requestedId}" to agents.entries.${id}.`);
    }
  }
  return { entries, diagnostics };
}

/** Converts a valid legacy roster without applying ownership or runtime migrations. */
export function parseLegacyAgentRoster(
  value: unknown,
): { entries: Record<string, Record<string, unknown>>; order: string[] } | undefined {
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
  options: {
    materializeWorkspace?: boolean;
    materializeRoles?: boolean;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  } = {},
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
  let legacyRoster: ReturnType<typeof parseLegacyAgentRoster>;
  let rosterProperty = readAgentRosterProperty({ ...root, agents });
  if (rosterProperty?.kind === "list") {
    const roster = parseLegacyAgentRoster(rosterProperty.value);
    if (!roster) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    legacyRoster = roster;
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
    legacyRoster?.order ??
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
  if (legacyRoster && !legacyDefaultAgentId) {
    const firstId = legacyRoster.order[0]!;
    const entry = legacyRoster.entries[firstId]!;
    const workspace = resolveLegacyFirstAgentWorkspacePin(
      agents,
      legacyRoster.order.map((id) => legacyRoster.entries[id]!),
      options,
    );
    if (workspace !== undefined) {
      nextRoot = {
        ...nextRoot,
        agents: { ...agents, entries: { ...roster, [firstId]: { ...entry, workspace } } },
      };
      insertedPaths.push(["agents", "entries", firstId, "workspace"]);
      diagnostics.push("Preserved the first legacy agent's existing workspace.");
    }
  }
  if (legacyDefaultAgentId && options.materializeRoles !== false) {
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
