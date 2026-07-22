import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

function migrateAgentEntries(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  if (!agents || !Array.isArray(agents.list)) {
    return;
  }
  if (getRecord(agents.entries)) {
    delete agents.list;
    changes.push("Removed agents.list because canonical agents.entries is already set.");
    return;
  }
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
    Object.defineProperty(entries, key, {
      configurable: true,
      enumerable: true,
      value: config,
      writable: true,
    });
    if (key !== requestedId) {
      changes.push(`Moved duplicate agents.list id "${requestedId}" to agents.entries.${key}.`);
    }
  }
  agents.entries = entries;
  delete agents.list;
  changes.push("Moved agents.list → keyed agents.entries.");
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.agents-entries",
    describe: "Move agent arrays to keyed entries",
    legacyRules: [
      {
        path: ["agents", "list"],
        message: 'agents.list moved to keyed agents.entries. Run "openclaw doctor --fix".',
      },
    ],
    apply: migrateAgentEntries,
  }),
];
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
