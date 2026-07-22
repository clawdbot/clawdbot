import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";

/** Every missing or empty roster is the shipped implicit-main shape. */
export function migratePersistedImplicitMainRoster(raw: unknown): {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
} {
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
    return {
      config: { ...root, agents: { ...agents, entries: { main: { default: true } } } },
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
  const defaultIds = validIds.filter(
    (id) => (roster[id] as Record<string, unknown>).default === true,
  );
  if (defaultIds.length === 1) {
    return convertedLegacyList
      ? {
          config: { ...root, agents },
          changed: true,
          diagnostics: ["Moved agents.list to keyed agents.entries."],
        }
      : { config: raw, changed: false, diagnostics: [] };
  }
  const effectiveId = defaultIds[0] ?? validIds[0]!;
  const repaired = Object.fromEntries(
    Object.entries(roster).map(([id, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [id, entry];
      }
      const next = Object.assign({}, entry as Record<string, unknown>);
      if (id === effectiveId) {
        next.default = true;
      } else {
        delete next.default;
      }
      return [id, next];
    }),
  );
  return {
    config: { ...root, agents: { ...agents, entries: repaired } },
    changed: true,
    diagnostics: [
      ...(convertedLegacyList ? ["Moved agents.list to keyed agents.entries."] : []),
      defaultIds.length === 0
        ? `Migrated agents.entries by marking "${effectiveId}" as default.`
        : `Migrated agents.entries by keeping "${effectiveId}" as default and clearing ${defaultIds.length - 1} duplicate marker(s).`,
    ],
  };
}
