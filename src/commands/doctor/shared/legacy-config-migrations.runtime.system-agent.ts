// Restores legacy ambient ownership and removes the retired system-agent alias.
import { parseLegacyAgentRoster } from "../../../config/legacy.roster.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { normalizeAgentId } from "../../../routing/session-key.js";

function resolveMissingLegacySystemAgent(raw: Record<string, unknown>) {
  const agents = getRecord(raw.agents);
  if (!agents) {
    return undefined;
  }
  const defaults = getRecord(agents.defaults);
  const systemAgent = getRecord(defaults?.systemAgent);
  if (
    (agents.defaults !== undefined && !defaults) ||
    (defaults?.systemAgent !== undefined && !systemAgent) ||
    systemAgent?.agentId !== undefined
  ) {
    return undefined;
  }
  const roster =
    agents.entries !== undefined
      ? getRecord(agents.entries)
      : parseLegacyAgentRoster(agents.list)?.entries;
  if (!roster) {
    return undefined;
  }
  const entries = Object.entries(roster).flatMap(([id, value]) => {
    const config = getRecord(value);
    return config && id.trim() ? [{ id: normalizeAgentId(id), config }] : [];
  });
  const marked = entries.filter((entry) => entry.config.default === true);
  // The runtime already resolves sole agents and honored legacy default markers.
  if (
    entries.length < 2 ||
    marked.length > 1 ||
    (marked.length === 1 && agents.ownership !== "explicit")
  ) {
    return undefined;
  }
  const selected = marked[0] ?? entries.find((entry) => entry.id === "main");
  if (!selected) {
    return undefined;
  }
  // Shared defaults and per-agent heartbeat blocks already enroll agents explicitly.
  const heartbeatUnresolved =
    defaults?.heartbeat === undefined && !entries.some((entry) => entry.config.heartbeat);
  return { agentId: selected.id, heartbeatUnresolved };
}

// Missing optional ownership is Doctor advice, not a runtime validation issue.
export function findLegacySystemAgentOwnerIssue(raw: unknown) {
  const root = getRecord(raw);
  return root && resolveMissingLegacySystemAgent(root)
    ? {
        path: "agents",
        message:
          'Legacy ambient operations have no system-agent owner; run "openclaw doctor --fix" to set agents.defaults.systemAgent.agentId from the default agent.',
      }
    : undefined;
}

const LEGACY_SYSTEM_AGENT_CONFIG_RULE: LegacyConfigRule = {
  path: ["crestodian"],
  message:
    'crestodian config was retired; system-agent rescue now uses built-in policy. Run "openclaw doctor --fix" to remove it.',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "crestodian-retired",
    describe: "Remove retired system-agent config",
    legacyRules: [LEGACY_SYSTEM_AGENT_CONFIG_RULE],
    apply: (raw, changes) => {
      if (!Object.hasOwn(raw, "crestodian")) {
        return;
      }
      delete raw.crestodian;
      changes.push("Removed retired crestodian config; system-agent rescue uses built-in policy.");
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.legacy-system-agent-owner",
    describe: "Restore the legacy default agent for ambient operations",
    apply: (raw, changes) => {
      const owner = resolveMissingLegacySystemAgent(raw);
      if (!owner) {
        return;
      }
      const { agentId, heartbeatUnresolved } = owner;
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      ensureRecord(defaults, "systemAgent").agentId = agentId;
      changes.push(
        `Set agents.defaults.systemAgent.agentId to ${agentId} for legacy ambient operations.`,
      );
      if (heartbeatUnresolved) {
        ensureRecord(defaults, "heartbeat").agentId = agentId;
        changes.push(`Set agents.defaults.heartbeat.agentId to ${agentId} for legacy heartbeats.`);
      }
    },
  }),
];
