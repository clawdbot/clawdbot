import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../config/prototype-keys.js";

const AGENT_HEARTBEAT_KEYS = new Set([
  "every",
  "activeHours",
  "model",
  "session",
  "includeReasoning",
  "target",
  "directPolicy",
  "to",
  "accountId",
  "prompt",
  "ackMaxChars",
  "suppressToolErrorWarnings",
  "lightContext",
  "isolatedSession",
]);

const CHANNEL_HEARTBEAT_KEYS = new Set(["showOk", "showAlerts", "useIndicator"]);

const MEMORY_SEARCH_RULE: LegacyConfigRule = {
  path: ["memorySearch"],
  message:
    'top-level memorySearch was moved; use agents.defaults.memorySearch instead. Run "openclaw doctor --fix".',
};

const HEARTBEAT_RULE: LegacyConfigRule = {
  path: ["heartbeat"],
  message:
    "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
};

const LEGACY_SANDBOX_SCOPE_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "sandbox"],
    message:
      'agents.defaults.sandbox.perSession is legacy; use agents.defaults.sandbox.scope instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacySandboxPerSession(value),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].sandbox.perSession is legacy; use agents.list[].sandbox.scope instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAgentListSandboxPerSession(value),
  },
];

const LEGACY_AGENT_RUNTIME_POLICY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "embeddedHarness"],
    message:
      'agents.defaults.embeddedHarness is legacy; use agents.defaults.agentRuntime instead. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].embeddedHarness is legacy; use agents.list[].agentRuntime instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAgentListEmbeddedHarness(value),
  },
];

function sandboxScopeFromPerSession(perSession: boolean): "session" | "shared" {
  return perSession ? "session" : "shared";
}

function splitLegacyHeartbeat(legacyHeartbeat: Record<string, unknown>): {
  agentHeartbeat: Record<string, unknown> | null;
  channelHeartbeat: Record<string, unknown> | null;
} {
  const agentHeartbeat: Record<string, unknown> = {};
  const channelHeartbeat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(legacyHeartbeat)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (CHANNEL_HEARTBEAT_KEYS.has(key)) {
      channelHeartbeat[key] = value;
      continue;
    }
    if (AGENT_HEARTBEAT_KEYS.has(key)) {
      agentHeartbeat[key] = value;
      continue;
    }
    agentHeartbeat[key] = value;
  }

  return {
    agentHeartbeat: Object.keys(agentHeartbeat).length > 0 ? agentHeartbeat : null,
    channelHeartbeat: Object.keys(channelHeartbeat).length > 0 ? channelHeartbeat : null,
  };
}

function mergeLegacyIntoDefaults(params: {
  raw: Record<string, unknown>;
  rootKey: "agents" | "channels";
  fieldKey: string;
  legacyValue: Record<string, unknown>;
  changes: string[];
  movedMessage: string;
  mergedMessage: string;
}) {
  const root = ensureRecord(params.raw, params.rootKey);
  const defaults = ensureRecord(root, "defaults");
  const existing = getRecord(defaults[params.fieldKey]);
  if (!existing) {
    defaults[params.fieldKey] = params.legacyValue;
    params.changes.push(params.movedMessage);
  } else {
    const merged = structuredClone(existing);
    mergeMissing(merged, params.legacyValue);
    defaults[params.fieldKey] = merged;
    params.changes.push(params.mergedMessage);
  }

  root.defaults = defaults;
  params.raw[params.rootKey] = root;
}

function hasLegacySandboxPerSession(value: unknown): boolean {
  const sandbox = getRecord(value);
  return Boolean(sandbox && Object.prototype.hasOwnProperty.call(sandbox, "perSession"));
}

function hasLegacyAgentListSandboxPerSession(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((agent) => hasLegacySandboxPerSession(getRecord(agent)?.sandbox));
}

function hasLegacyAgentListEmbeddedHarness(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((agent) => getRecord(getRecord(agent)?.embeddedHarness) !== null);
}

function migrateLegacySandboxPerSession(
  sandbox: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (!Object.prototype.hasOwnProperty.call(sandbox, "perSession")) {
    return;
  }
  const rawPerSession = sandbox.perSession;
  if (typeof rawPerSession !== "boolean") {
    return;
  }
  if (sandbox.scope === undefined) {
    sandbox.scope = sandboxScopeFromPerSession(rawPerSession);
    changes.push(`Moved ${pathLabel}.perSession → ${pathLabel}.scope (${String(sandbox.scope)}).`);
  } else {
    changes.push(`Removed ${pathLabel}.perSession (${pathLabel}.scope already set).`);
  }
  delete sandbox.perSession;
}

function migrateLegacyAgentRuntimePolicy(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  const legacy = getRecord(container.embeddedHarness);
  if (!legacy) {
    return;
  }

  const existing = getRecord(container.agentRuntime);
  const next = existing ? structuredClone(existing) : {};
  if (next.id === undefined && legacy.runtime !== undefined) {
    next.id = legacy.runtime;
  }
  if (next.fallback === undefined && legacy.fallback !== undefined) {
    next.fallback = legacy.fallback;
  }

  if (Object.keys(next).length > 0) {
    container.agentRuntime = next;
  }
  delete container.embeddedHarness;
  changes.push(`Moved ${pathLabel}.embeddedHarness → ${pathLabel}.agentRuntime.`);
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.embeddedHarness->agentRuntime",
    describe: "Move legacy embeddedHarness runtime policy to agentRuntime",
    legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      if (defaults) {
        migrateLegacyAgentRuntimePolicy(defaults, "agents.defaults", changes);
      }

      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, agent] of agents.list.entries()) {
        const agentRecord = getRecord(agent);
        if (!agentRecord) {
          continue;
        }
        migrateLegacyAgentRuntimePolicy(agentRecord, `agents.list.${index}`, changes);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "agents.sandbox.perSession->scope",
    describe: "Move legacy agent sandbox perSession aliases to sandbox.scope",
    legacyRules: LEGACY_SANDBOX_SCOPE_RULES,
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      const defaultSandbox = getRecord(defaults?.sandbox);
      if (defaultSandbox) {
        migrateLegacySandboxPerSession(defaultSandbox, "agents.defaults.sandbox", changes);
      }

      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, agent] of agents.list.entries()) {
        const sandbox = getRecord(getRecord(agent)?.sandbox);
        if (!sandbox) {
          continue;
        }
        migrateLegacySandboxPerSession(sandbox, `agents.list.${index}.sandbox`, changes);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "memorySearch->agents.defaults.memorySearch",
    describe: "Move top-level memorySearch to agents.defaults.memorySearch",
    legacyRules: [MEMORY_SEARCH_RULE],
    apply: (raw, changes) => {
      const legacyMemorySearch = getRecord(raw.memorySearch);
      if (!legacyMemorySearch) {
        return;
      }

      mergeLegacyIntoDefaults({
        raw,
        rootKey: "agents",
        fieldKey: "memorySearch",
        legacyValue: legacyMemorySearch,
        changes,
        movedMessage: "Moved memorySearch → agents.defaults.memorySearch.",
        mergedMessage:
          "Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).",
      });
      delete raw.memorySearch;
    },
  }),
  defineLegacyConfigMigration({
    id: "heartbeat->agents.defaults.heartbeat",
    describe: "Move top-level heartbeat to agents.defaults.heartbeat/channels.defaults.heartbeat",
    legacyRules: [HEARTBEAT_RULE],
    apply: (raw, changes) => {
      const legacyHeartbeat = getRecord(raw.heartbeat);
      if (!legacyHeartbeat) {
        return;
      }

      const { agentHeartbeat, channelHeartbeat } = splitLegacyHeartbeat(legacyHeartbeat);

      if (agentHeartbeat) {
        mergeLegacyIntoDefaults({
          raw,
          rootKey: "agents",
          fieldKey: "heartbeat",
          legacyValue: agentHeartbeat,
          changes,
          movedMessage: "Moved heartbeat → agents.defaults.heartbeat.",
          mergedMessage:
            "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
        });
      }

      if (channelHeartbeat) {
        mergeLegacyIntoDefaults({
          raw,
          rootKey: "channels",
          fieldKey: "heartbeat",
          legacyValue: channelHeartbeat,
          changes,
          movedMessage: "Moved heartbeat visibility → channels.defaults.heartbeat.",
          mergedMessage:
            "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
        });
      }

      if (!agentHeartbeat && !channelHeartbeat) {
        changes.push("Removed empty top-level heartbeat.");
      }
      delete raw.heartbeat;
    },
  }),
];
