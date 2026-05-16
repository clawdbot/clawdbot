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
    path: ["agents", "defaults", "agentRuntime", "fallback"],
    message:
      'agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "defaults", "embeddedHarness"],
    message:
      'agents.defaults.embeddedHarness is legacy and ignored; set provider/model runtime policy instead. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents", "defaults", "agentRuntime"],
    message:
      'agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].agentRuntime is ignored; set provider/model runtime policy instead. Run "openclaw doctor --fix".',
    match: (value) => hasAgentListRuntimePolicy(value),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].embeddedHarness is legacy and ignored; set provider/model runtime policy instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAgentListEmbeddedHarness(value),
  },
];

const LEGACY_AGENT_LLM_TIMEOUT_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "llm"],
    message:
      'agents.defaults.llm is legacy; use models.providers.<id>.timeoutSeconds for slow model/provider timeouts. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
];

const SILENT_REPLY_LEGACY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "silentReplyRewrite"],
    message:
      'agents.defaults.silentReplyRewrite was removed; exact NO_REPLY is no longer rewritten to visible fallback text. Run "openclaw doctor --fix" to remove it.',
  },
  {
    path: ["agents", "defaults", "silentReply"],
    message:
      'agents.defaults.silentReply.direct was removed; direct chats never receive NO_REPLY prompt guidance. Run "openclaw doctor --fix" to remove it.',
    match: (value) => Object.prototype.hasOwnProperty.call(getRecord(value) ?? {}, "direct"),
  },
  {
    path: ["surfaces"],
    message:
      'surfaces.*.silentReplyRewrite was removed; exact NO_REPLY is no longer rewritten to visible fallback text. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasSurfaceSilentReplyRewrite(value),
  },
  {
    path: ["surfaces"],
    message:
      'surfaces.*.silentReply.direct was removed; direct chats never receive NO_REPLY prompt guidance. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasSurfaceSilentReplyDirect(value),
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

function hasAgentListRuntimePolicy(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((agent) => getRecord(getRecord(agent)?.agentRuntime) !== null);
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

function removeLegacyAgentRuntimePolicy(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (getRecord(container.embeddedHarness) !== null) {
    delete container.embeddedHarness;
    changes.push(`Removed ${pathLabel}.embeddedHarness; runtime is now provider/model scoped.`);
  }
  if (getRecord(container.agentRuntime) !== null) {
    delete container.agentRuntime;
    changes.push(`Removed ${pathLabel}.agentRuntime; runtime is now provider/model scoped.`);
  }
}

function hasOwnRecordProperty(value: unknown, key: string): boolean {
  const record = getRecord(value);
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}

function hasSurfaceSilentReplyRewrite(value: unknown): boolean {
  const surfaces = getRecord(value);
  if (!surfaces) {
    return false;
  }
  return Object.entries(surfaces).some(
    ([surfaceId, surface]) =>
      !isBlockedObjectKey(surfaceId) && hasOwnRecordProperty(surface, "silentReplyRewrite"),
  );
}

function hasSurfaceSilentReplyDirect(value: unknown): boolean {
  const surfaces = getRecord(value);
  if (!surfaces) {
    return false;
  }
  return Object.values(surfaces).some((surface) =>
    Object.prototype.hasOwnProperty.call(
      getRecord(getRecord(surface)?.silentReply) ?? {},
      "direct",
    ),
  );
}

function removeLegacySilentReplyConfig(raw: Record<string, unknown>, changes: string[]): void {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  const defaultSilentReply = getRecord(defaults?.silentReply);
  if (defaultSilentReply && Object.prototype.hasOwnProperty.call(defaultSilentReply, "direct")) {
    delete defaultSilentReply.direct;
    changes.push("Removed agents.defaults.silentReply.direct; direct chats never use NO_REPLY.");
  }
  if (defaults && hasOwnRecordProperty(defaults, "silentReplyRewrite")) {
    delete defaults.silentReplyRewrite;
    changes.push("Removed agents.defaults.silentReplyRewrite.");
  }

  const surfaces = getRecord(raw.surfaces);
  if (!surfaces) {
    return;
  }
  for (const [surfaceId, surfaceValue] of Object.entries(surfaces)) {
    if (isBlockedObjectKey(surfaceId)) {
      continue;
    }
    const surface = getRecord(surfaceValue);
    if (!surface) {
      continue;
    }
    const silentReply = getRecord(surface.silentReply);
    if (silentReply && Object.prototype.hasOwnProperty.call(silentReply, "direct")) {
      delete silentReply.direct;
      changes.push(
        `Removed surfaces.${surfaceId}.silentReply.direct; direct chats never use NO_REPLY.`,
      );
    }
    if (hasOwnRecordProperty(surface, "silentReplyRewrite")) {
      delete surface.silentReplyRewrite;
      changes.push(`Removed surfaces.${surfaceId}.silentReplyRewrite.`);
    }
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "silentReplyRewrite-removed",
    describe: "Remove legacy silent reply rewrite and direct-chat silent reply config",
    legacyRules: SILENT_REPLY_LEGACY_RULES,
    apply: removeLegacySilentReplyConfig,
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.llm->models.providers.timeoutSeconds",
    describe: "Remove legacy agents.defaults.llm timeout config",
    legacyRules: LEGACY_AGENT_LLM_TIMEOUT_RULES,
    apply: (raw, changes) => {
      const defaults = getRecord(getRecord(raw.agents)?.defaults);
      if (!defaults || getRecord(defaults.llm) === null) {
        return;
      }
      delete defaults.llm;
      changes.push(
        "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds within the agent/run timeout ceiling.",
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "agents.agentRuntime-ignored",
    describe: "Remove ignored agent-wide runtime policy",
    legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      if (defaults) {
        removeLegacyAgentRuntimePolicy(defaults, "agents.defaults", changes);
      }

      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, agent] of agents.list.entries()) {
        const agentRecord = getRecord(agent);
        if (!agentRecord) {
          continue;
        }
        removeLegacyAgentRuntimePolicy(agentRecord, `agents.list.${index}`, changes);
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
