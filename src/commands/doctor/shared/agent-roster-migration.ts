import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { tryResolveDefaultAgentId } from "../../../agents/agent-scope-config.js";
import { getRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

function setRecordEntry(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Repairs legacy or incomplete persisted rosters at Doctor's write boundary. */
export function migrateDoctorAgentRoster(raw: Record<string, unknown>, changes: string[]): void {
  const hasAgents = Object.hasOwn(raw, "agents");
  let agents = getRecord(raw.agents);
  if (hasAgents && !agents) {
    return;
  }
  agents ??= {};

  if (Object.hasOwn(agents, "list")) {
    if (!Array.isArray(agents.list)) {
      return;
    }
    if (getRecord(agents.entries)) {
      delete agents.list;
      changes.push("Removed agents.list because canonical agents.entries is already set.");
    } else {
      const entries: Record<string, unknown> = {};
      for (const [index, value] of agents.list.entries()) {
        const entry = getRecord(value);
        if (!entry) {
          changes.push(`Removed malformed agents.list[${index}] entry.`);
          continue;
        }
        const rawId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "agent";
        const requestedId = normalizeAgentId(rawId);
        if (requestedId !== rawId) {
          changes.push(`Normalized agents.list id "${rawId}" → agents.entries.${requestedId}.`);
        }
        let key = requestedId;
        let suffix = 2;
        while (Object.hasOwn(entries, key)) {
          key = `${requestedId}-${suffix}`;
          suffix += 1;
        }
        const { id: _id, ...config } = entry;
        setRecordEntry(entries, key, config);
        if (key !== requestedId) {
          changes.push(`Moved duplicate agents.list id "${requestedId}" to agents.entries.${key}.`);
        }
      }
      agents.entries = entries;
      delete agents.list;
      changes.push("Moved agents.list → keyed agents.entries.");
    }
  }

  if (!Object.hasOwn(agents, "entries")) {
    agents.entries = { main: { default: true } };
    raw.agents = agents;
    changes.push("Created agents.entries.main as the explicit default agent.");
    return;
  }
  const entries = getRecord(agents.entries);
  if (!entries) {
    return;
  }
  if (Object.keys(entries).length === 0) {
    agents.entries = { main: { default: true } };
    raw.agents = agents;
    changes.push("Created agents.entries.main as the explicit default agent.");
    return;
  }

  const validIds = Object.entries(entries).flatMap(([id, entry]) => (getRecord(entry) ? [id] : []));
  if (validIds.length === 0) {
    return;
  }
  if (
    validIds.some((id) => {
      const entry = getRecord(entries[id])!;
      return Object.hasOwn(entry, "default") && typeof entry.default !== "boolean";
    })
  ) {
    return;
  }
  const defaultIds = validIds.filter((id) => getRecord(entries[id])?.default === true);
  if (defaultIds.length === 1) {
    raw.agents = agents;
    return;
  }

  const effectiveId = defaultIds[0] ?? validIds[0]!;
  for (const id of validIds) {
    const entry = getRecord(entries[id])!;
    if (id === effectiveId) {
      entry.default = true;
    } else {
      delete entry.default;
    }
  }
  raw.agents = agents;
  changes.push(
    defaultIds.length === 0
      ? `Migrated agents.entries by marking "${effectiveId}" as default.`
      : `Migrated agents.entries by keeping "${effectiveId}" as default and clearing ${defaultIds.length - 1} duplicate marker(s).`,
  );
}

export function planDoctorAgentRosterMigration(raw: unknown): {
  config: unknown;
  changes: string[];
} {
  if (!getRecord(raw)) {
    return { config: raw, changes: [] };
  }
  const config = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  migrateDoctorAgentRoster(config, changes);
  return { config, changes };
}

/** Supplies a temporary current-shape roster only for Doctor metadata inspection. */
export function createDoctorRosterInspectionConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  defaultAgentId: string;
} {
  const defaultAgentId = tryResolveDefaultAgentId(config);
  if (defaultAgentId) {
    return { config, defaultAgentId };
  }
  return {
    config: {
      ...config,
      agents: { ...config.agents, entries: { main: { default: true } } },
    },
    defaultAgentId: "main",
  };
}
