// Legacy runtime agent config migrations for memory, heartbeat, sandbox, and runtime policy keys.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  isCanonicalToolProviderPolicyKey,
  normalizeToolProviderPolicyKey,
} from "../../../agents/provider-tool-policy.js";
import { DEFAULT_SANDBOX_BROWSER_NETWORK } from "../../../agents/sandbox/browser-network.js";
import { isKnownCoreToolId } from "../../../agents/tool-catalog.js";
import { isToolAllowedByPolicyName } from "../../../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../../../agents/tool-policy-shared.js";
import { expandToolGroups, mergeAlsoAllowPolicy } from "../../../agents/tool-policy.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import {
  modelEntryWithRuntimePolicy,
  selectedCanonicalModelRefsForRuntimePolicy,
} from "./legacy-runtime-model-policy.js";
import { listLegacyRuntimeModelProviderAliases } from "./legacy-runtime-model-providers.js";

const CHANNEL_HEARTBEAT_KEYS = new Set(["showOk", "showAlerts", "useIndicator"]);

type LegacyAgentRuntimeIntent = {
  provider: string;
  runtime: string;
};

const LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS = [
  { legacyKey: "chunkSize", parentKey: "chunking", canonicalKey: "tokens" },
  { legacyKey: "chunkOverlap", parentKey: "chunking", canonicalKey: "overlap" },
  { legacyKey: "maxResults", parentKey: "query", canonicalKey: "maxResults" },
] as const;

const MEMORY_SEARCH_RULE: LegacyConfigRule = {
  path: ["memorySearch"],
  message:
    'top-level memorySearch was moved; use memory.search instead. Run "openclaw doctor --fix".',
};

const AGENT_MEMORY_SEARCH_OWNER_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "memorySearch"],
    message: 'agents.defaults.memorySearch moved to memory.search. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].memorySearch moved to agents.list[].memory.search. Run "openclaw doctor --fix".',
    match: (value) => someAgentList(value, (agent) => agent.memorySearch !== undefined),
  },
];

const LEGACY_MEMORY_SEARCH_AUTO_PROVIDER_RULES: LegacyConfigRule[] = [
  {
    path: ["memorySearch", "provider"],
    message:
      'memorySearch.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: isLegacyMemorySearchAutoProvider,
  },
  {
    path: ["memory", "search", "provider"],
    message:
      'memory.search.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: isLegacyMemorySearchAutoProvider,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].memorySearch.provider = "auto" is legacy; use "openai" explicitly. Run "openclaw doctor --fix".',
    match: (value) =>
      someAgentList(value, (agent) =>
        isLegacyMemorySearchAutoProvider(getAgentMemorySearchRecord(agent)?.provider),
      ),
  },
];

const LEGACY_MEMORY_SEARCH_STORE_PATH_RULES: LegacyConfigRule[] = [
  {
    path: ["memorySearch", "store", "path"],
    message:
      'memorySearch.store.path is legacy; memory indexes now live in each agent database. Run "openclaw doctor --fix".',
  },
  {
    path: ["memory", "search", "store", "path"],
    message:
      'memory.search.store.path is legacy; memory indexes now live in each agent database. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].memorySearch.store.path is legacy; memory indexes now live in each agent database. Run "openclaw doctor --fix".',
    match: (value) =>
      someAgentList(value, (agent) => hasMemorySearchStorePath(getAgentMemorySearchRecord(agent))),
  },
];

const LEGACY_MEMORY_SEARCH_FLAT_KEY_RULES: LegacyConfigRule[] = [
  {
    path: ["memory", "search"],
    message:
      'memory.search uses legacy flat chunkSize, chunkOverlap, or maxResults fields. Run "openclaw doctor --fix".',
    match: hasLegacyMemorySearchFlatKeys,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].memorySearch uses legacy flat chunkSize, chunkOverlap, or maxResults fields. Run "openclaw doctor --fix".',
    match: (value) =>
      someAgentList(value, (agent) =>
        hasLegacyMemorySearchFlatKeys(getAgentMemorySearchRecord(agent)),
      ),
  },
];

function hasLegacyMemorySearchFlatKeys(value: unknown): boolean {
  const memorySearch = getRecord(value);
  return Boolean(
    memorySearch &&
    LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS.some(({ legacyKey }) =>
      Object.hasOwn(memorySearch, legacyKey),
    ),
  );
}

function getAgentMemorySearchRecord(agent: unknown): Record<string, unknown> | null {
  const record = getRecord(agent);
  return getRecord(record?.memorySearch) ?? getRecord(getRecord(record?.memory)?.search);
}

function someAgentList(
  value: unknown,
  predicate: (agent: Record<string, unknown>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      const agent = getRecord(entry);
      return agent !== null && predicate(agent);
    })
  );
}

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
    match: (value) => someAgentList(value, (agent) => hasLegacySandboxPerSession(agent.sandbox)),
  },
];

const UNSUPPORTED_SANDBOX_BROWSER_NETWORK_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "sandbox", "browser", "network"],
    message:
      'agents.defaults.sandbox.browser.network = "none" cannot expose the browser control port. Run "openclaw doctor --fix" to disable the sidecar and restore the dedicated browser network.',
    match: isUnsupportedSandboxBrowserNetwork,
  },
  {
    path: ["agents", "entries"],
    message:
      'agents.entries.*.sandbox.browser.network = "none" cannot expose the browser control port. Run "openclaw doctor --fix" to disable the affected sidecar and restore the dedicated browser network.',
    match: hasAgentEntriesUnsupportedSandboxBrowserNetwork,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].sandbox.browser.network = "none" cannot expose the browser control port. Run "openclaw doctor --fix" to disable the affected sidecar and restore the dedicated browser network.',
    match: (value) =>
      someAgentList(value, (agent) =>
        isUnsupportedSandboxBrowserNetwork(getSandboxBrowserConfig(agent)?.network),
      ),
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
    match: (value) => someAgentList(value, (agent) => getRecord(agent.agentRuntime) !== null),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].embeddedHarness is legacy and ignored; set provider/model runtime policy instead. Run "openclaw doctor --fix".',
    match: (value) => someAgentList(value, (agent) => getRecord(agent.embeddedHarness) !== null),
  },
];

const DEPRECATED_EMBEDDED_AGENT_KEY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "embeddedPi"],
    message:
      'agents.defaults.embeddedPi is legacy; use agents.defaults.embeddedAgent instead. Run "openclaw doctor --fix".',
    match: (value) => getRecord(value) !== null,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].embeddedPi is legacy; use agents.list[].embeddedAgent instead. Run "openclaw doctor --fix".',
    match: (value) => someAgentList(value, (agent) => getRecord(agent.embeddedPi) !== null),
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

const IGNORED_AGENT_MODEL_TIMEOUT_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "model"],
    message:
      'agents.defaults.model.timeoutMs is ignored; agent model config only selects primary/fallback models. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasOwnTimeoutMs(value),
  },
  {
    path: ["agents", "defaults", "subagents", "model"],
    message:
      'agents.defaults.subagents.model.timeoutMs is ignored; subagent model config only selects primary/fallback models. Run "openclaw doctor --fix" to remove it.',
    match: (value) => hasOwnTimeoutMs(value),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].model.timeoutMs and agents.list[].subagents.model.timeoutMs are ignored; agent model config only selects primary/fallback models. Run "openclaw doctor --fix" to remove them.',
    match: (value) =>
      someAgentList(
        value,
        (agent) =>
          hasOwnTimeoutMs(agent.model) || hasOwnTimeoutMs(getRecord(agent.subagents)?.model),
      ),
  },
];

const PROFILE_CONFIGURED_TOOL_SECTION_RULES: LegacyConfigRule[] = [
  {
    path: ["tools"],
    message:
      'tools.profile filters explicit configured-section tool grants; run "openclaw doctor --fix" to rewrite the explicit grants into a valid allowlist.',
    match: (value) => toolProfileConfiguredSectionsNeedExplicitRepair(value),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].tools.profile filters explicit configured-section tool grants; run "openclaw doctor --fix" to rewrite the explicit grants into a valid allowlist.',
    match: (value, root) => {
      const globalTools = getRecord(root.tools);
      const inheritedProfile =
        typeof globalTools?.profile === "string" ? globalTools.profile : undefined;
      const inheritedAlsoAllow = readToolPolicyGrantList(globalTools, "alsoAllow");
      return (
        Array.isArray(value) &&
        value.some((agent) => {
          const agentTools = getRecord(getRecord(agent)?.tools);
          return toolProfileConfiguredSectionsNeedExplicitRepair(
            agentTools,
            inheritedProfile,
            inheritedAlsoAllow,
            collectEffectiveConfiguredToolSectionGrants(globalTools, agentTools),
            getRecord(globalTools?.byProvider),
          );
        })
      );
    },
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
    match: (value) => Object.hasOwn(getRecord(value) ?? {}, "direct"),
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

const SYSTEM_PROMPT_OVERRIDE_LEGACY_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "systemPromptOverride"],
    message:
      'agents.defaults.systemPromptOverride was removed; OpenClaw owns the generated system prompt. Run "openclaw doctor --fix" to remove it.',
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].systemPromptOverride was removed; OpenClaw owns the generated system prompt. Run "openclaw doctor --fix" to remove it.',
    match: (value) => someAgentList(value, (agent) => Object.hasOwn(agent, "systemPromptOverride")),
  },
];

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
  return Boolean(sandbox && Object.hasOwn(sandbox, "perSession"));
}

function hasOwnTimeoutMs(value: unknown): boolean {
  const record = getRecord(value);
  return Boolean(record && Object.hasOwn(record, "timeoutMs"));
}

function migrateAgentDefaultsAndList(
  raw: Record<string, unknown>,
  changes: string[],
  migrateAgent: (agent: Record<string, unknown>, pathLabel: string, changes: string[]) => void,
): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  if (defaults) {
    migrateAgent(defaults, "agents.defaults", changes);
  }
  if (!Array.isArray(agents?.list)) {
    return;
  }
  for (const [index, agent] of agents.list.entries()) {
    const agentRecord = getRecord(agent);
    if (agentRecord) {
      migrateAgent(agentRecord, `agents.list.${index}`, changes);
    }
  }
}

function migrateLegacyEmbeddedAgentKey(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  const legacy = getRecord(container.embeddedPi);
  if (!legacy) {
    return;
  }
  const existing = getRecord(container.embeddedAgent);
  if (!existing) {
    container.embeddedAgent = legacy;
    changes.push(`Moved ${pathLabel}.embeddedPi → ${pathLabel}.embeddedAgent.`);
  } else {
    const merged = structuredClone(existing);
    mergeMissing(merged, legacy);
    container.embeddedAgent = merged;
    changes.push(
      `Merged ${pathLabel}.embeddedPi → ${pathLabel}.embeddedAgent (filled missing fields from legacy; kept explicit embeddedAgent values).`,
    );
  }
  delete container.embeddedPi;
}

function isLegacyMemorySearchAutoProvider(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

function hasMemorySearchStorePath(value: unknown): boolean {
  return typeof getRecord(getRecord(value)?.store)?.path === "string";
}

function migrateLegacyMemorySearchFlatKeys(
  memorySearch: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): void {
  if (!memorySearch) {
    return;
  }
  for (const { legacyKey, parentKey, canonicalKey } of LEGACY_MEMORY_SEARCH_FIELD_MAPPINGS) {
    if (!Object.hasOwn(memorySearch, legacyKey)) {
      continue;
    }
    const legacyValue = memorySearch[legacyKey];
    if (memorySearch[parentKey] === undefined) {
      memorySearch[parentKey] = { [canonicalKey]: legacyValue };
      changes.push(`Moved ${pathLabel}.${legacyKey} → ${pathLabel}.${parentKey}.${canonicalKey}.`);
      delete memorySearch[legacyKey];
      continue;
    }
    const canonicalParent = getRecord(memorySearch[parentKey]);
    if (!canonicalParent) {
      changes.push(`Removed ${pathLabel}.${legacyKey} (${pathLabel}.${parentKey} already set).`);
    } else if (canonicalParent[canonicalKey] === undefined) {
      canonicalParent[canonicalKey] = legacyValue;
      changes.push(`Moved ${pathLabel}.${legacyKey} → ${pathLabel}.${parentKey}.${canonicalKey}.`);
    } else {
      changes.push(
        `Removed ${pathLabel}.${legacyKey} (${pathLabel}.${parentKey}.${canonicalKey} already set).`,
      );
    }
    delete memorySearch[legacyKey];
  }
}

function removeLegacyMemorySearchStorePath(
  memorySearch: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): void {
  const store = getRecord(memorySearch?.store);
  if (!store || typeof store.path !== "string") {
    return;
  }
  delete store.path;
  changes.push(`Removed ${pathLabel}.store.path; memory indexes now use each agent database.`);
}

function rewriteLegacyMemorySearchAutoProvider(
  memorySearch: Record<string, unknown> | null,
  pathLabel: string,
  changes: string[],
): void {
  if (!memorySearch || !isLegacyMemorySearchAutoProvider(memorySearch.provider)) {
    return;
  }
  memorySearch.provider = "openai";
  changes.push(`Moved ${pathLabel}.provider from legacy "auto" to "openai".`);
}

function migrateCanonicalMemorySearches(
  raw: Record<string, unknown>,
  changes: string[],
  migrateMemorySearch: (
    memorySearch: Record<string, unknown> | null,
    pathLabel: string,
    changes: string[],
  ) => void,
  agentPathStyle: "dot" | "brackets" = "dot",
): void {
  migrateMemorySearch(getRecord(getRecord(raw.memory)?.search), "memory.search", changes);
  const agents = getRecord(raw.agents);
  if (!Array.isArray(agents?.list)) {
    return;
  }
  for (const [index, agent] of agents.list.entries()) {
    const pathLabel =
      agentPathStyle === "brackets"
        ? `agents.list[${index}].memory.search`
        : `agents.list.${index}.memory.search`;
    migrateMemorySearch(getRecord(getRecord(getRecord(agent)?.memory)?.search), pathLabel, changes);
  }
}

function migrateLegacySandboxPerSession(
  sandbox: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (!Object.hasOwn(sandbox, "perSession")) {
    return;
  }
  const rawPerSession = sandbox.perSession;
  if (typeof rawPerSession !== "boolean") {
    return;
  }
  if (sandbox.scope === undefined) {
    sandbox.scope = rawPerSession ? "session" : "shared";
    changes.push(`Moved ${pathLabel}.perSession → ${pathLabel}.scope (${String(sandbox.scope)}).`);
  } else {
    changes.push(`Removed ${pathLabel}.perSession (${pathLabel}.scope already set).`);
  }
  delete sandbox.perSession;
}

function getSandboxBrowserConfig(container: unknown): Record<string, unknown> | null {
  return getRecord(getRecord(getRecord(container)?.sandbox)?.browser);
}

function isUnsupportedSandboxBrowserNetwork(value: unknown): boolean {
  return normalizeOptionalLowercaseString(value) === "none";
}

function hasAgentEntriesUnsupportedSandboxBrowserNetwork(value: unknown): boolean {
  const entries = getRecord(value);
  return Boolean(
    entries &&
    Object.entries(entries).some(
      ([agentId, agent]) =>
        !isBlockedObjectKey(agentId) &&
        isUnsupportedSandboxBrowserNetwork(getSandboxBrowserConfig(agent)?.network),
    ),
  );
}

function migrateExplicitUnsupportedSandboxBrowserNetwork(
  browser: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (!isUnsupportedSandboxBrowserNetwork(browser.network)) {
    return;
  }
  browser.enabled = false;
  browser.network = DEFAULT_SANDBOX_BROWSER_NETWORK;
  changes.push(
    `Disabled ${pathLabel} and moved its unsupported network "none" → "${DEFAULT_SANDBOX_BROWSER_NETWORK}".`,
  );
}

function migrateAgentBrowserInheritedFromUnsupportedDefault(params: {
  agent: unknown;
  pathLabel: string;
  defaultBrowserEnabled: boolean;
  changes: string[];
}): void {
  const browser = getSandboxBrowserConfig(params.agent);
  if (!browser) {
    return;
  }
  const hasExplicitNetwork = typeof browser.network === "string";
  const network = normalizeOptionalLowercaseString(browser.network);
  if (network === "none") {
    migrateExplicitUnsupportedSandboxBrowserNetwork(browser, params.pathLabel, params.changes);
    return;
  }
  if (!hasExplicitNetwork && browser.enabled === true) {
    browser.enabled = false;
    params.changes.push(
      `Disabled ${params.pathLabel} because it inherited unsupported browser network "none".`,
    );
    return;
  }
  if (hasExplicitNetwork && browser.enabled === undefined && params.defaultBrowserEnabled) {
    browser.enabled = true;
    params.changes.push(
      `Set ${params.pathLabel}.enabled to true to preserve its explicit supported network while disabling the unsupported default browser network.`,
    );
  }
}

function migrateUnsupportedSandboxBrowserNetworks(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  const defaultBrowser = getSandboxBrowserConfig(defaults);
  const defaultNetworkUnsupported = isUnsupportedSandboxBrowserNetwork(defaultBrowser?.network);
  const defaultBrowserEnabled = defaultBrowser?.enabled === true;
  const migrateAgentBrowser = (agent: unknown, pathLabel: string): void => {
    if (defaultNetworkUnsupported) {
      migrateAgentBrowserInheritedFromUnsupportedDefault({
        agent,
        pathLabel,
        defaultBrowserEnabled,
        changes,
      });
      return;
    }
    const browser = getSandboxBrowserConfig(agent);
    if (browser) {
      migrateExplicitUnsupportedSandboxBrowserNetwork(browser, pathLabel, changes);
    }
  };

  const entries = getRecord(agents?.entries);
  if (entries) {
    for (const [agentId, agent] of Object.entries(entries)) {
      if (isBlockedObjectKey(agentId)) {
        continue;
      }
      migrateAgentBrowser(agent, `agents.entries.${agentId}.sandbox.browser`);
    }
  }

  if (Array.isArray(agents?.list)) {
    for (const [index, agent] of agents.list.entries()) {
      migrateAgentBrowser(agent, `agents.list.${index}.sandbox.browser`);
    }
  }

  if (defaultBrowser) {
    migrateExplicitUnsupportedSandboxBrowserNetwork(
      defaultBrowser,
      "agents.defaults.sandbox.browser",
      changes,
    );
  }
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
    preserveLegacyWholeAgentRuntimePolicy(container, pathLabel, changes);
    delete container.agentRuntime;
    changes.push(`Removed ${pathLabel}.agentRuntime; runtime is now provider/model scoped.`);
  }
}

function resolveLegacyAgentRuntimeIntent(raw: unknown): LegacyAgentRuntimeIntent | undefined {
  const record = getRecord(raw);
  if (!record) {
    return undefined;
  }
  const runtime = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  if (!runtime || runtime === "auto" || runtime === "openclaw") {
    return undefined;
  }
  const alias = listLegacyRuntimeModelProviderAliases().find(
    (entry) => entry.cli && normalizeProviderId(entry.runtime) === runtime,
  );
  return alias ? { provider: alias.provider, runtime: alias.runtime } : undefined;
}

function preserveLegacyWholeAgentRuntimePolicy(
  container: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  const intent = resolveLegacyAgentRuntimeIntent(container.agentRuntime);
  if (!intent) {
    return;
  }
  const selectedRefs = selectedCanonicalModelRefsForRuntimePolicy(container.model, intent.provider);
  if (selectedRefs.length === 0) {
    return;
  }

  const currentModels = getRecord(container.models);
  const nextModels: Record<string, unknown> = currentModels ? { ...currentModels } : {};
  let changed = false;
  for (const ref of selectedRefs) {
    const updated = modelEntryWithRuntimePolicy(nextModels[ref], intent.runtime);
    if (!updated.changed) {
      continue;
    }
    nextModels[ref] = updated.entry;
    changed = true;
  }
  if (!changed) {
    return;
  }
  container.models = nextModels;
  changes.push(
    `Moved ${pathLabel}.agentRuntime.id ${intent.runtime} to matching ${intent.provider} model runtime policy.`,
  );
}

function removeIgnoredAgentModelTimeouts(
  agent: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  for (const [suffix, model] of [
    ["model", agent.model],
    ["subagents.model", getRecord(agent.subagents)?.model],
  ] as const) {
    const modelRecord = getRecord(model);
    if (!modelRecord || !Object.hasOwn(modelRecord, "timeoutMs")) {
      continue;
    }
    delete modelRecord.timeoutMs;
    changes.push(
      `Removed ${pathLabel}.${suffix}.timeoutMs; agent model config only selects models.`,
    );
  }
}

function hasOwnRecordProperty(value: unknown, key: string): boolean {
  const record = getRecord(value);
  return Boolean(record && Object.hasOwn(record, key));
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
    Object.hasOwn(getRecord(getRecord(surface)?.silentReply) ?? {}, "direct"),
  );
}

function removeLegacySilentReplyConfig(raw: Record<string, unknown>, changes: string[]): void {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  const defaultSilentReply = getRecord(defaults?.silentReply);
  if (defaultSilentReply && Object.hasOwn(defaultSilentReply, "direct")) {
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
    if (silentReply && Object.hasOwn(silentReply, "direct")) {
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

function removeLegacySystemPromptOverride(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  if (defaults && Object.hasOwn(defaults, "systemPromptOverride")) {
    delete defaults.systemPromptOverride;
    changes.push("Removed agents.defaults.systemPromptOverride.");
  }

  if (!Array.isArray(agents?.list)) {
    return;
  }
  for (const [index, agent] of agents.list.entries()) {
    const agentRecord = getRecord(agent);
    if (!agentRecord || !Object.hasOwn(agentRecord, "systemPromptOverride")) {
      continue;
    }
    delete agentRecord.systemPromptOverride;
    changes.push(`Removed agents.list.${index}.systemPromptOverride.`);
  }
}

const CONFIGURED_TOOL_SECTION_GRANTS = [
  { key: "exec", grants: ["exec", "process"] },
  { key: "fs", grants: ["read", "write", "edit"] },
] as const;

function readToolPolicyGrantList(value: unknown, key: "allow" | "alsoAllow"): string[] {
  return readOwnToolPolicyGrantList(value, key) ?? [];
}

function readOwnToolPolicyGrantList(
  value: unknown,
  key: "allow" | "alsoAllow",
): string[] | undefined {
  const tools = getRecord(value);
  return Array.isArray(tools?.[key])
    ? tools[key].filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function resolveToolProfileForMigration(
  tools: Record<string, unknown>,
  inheritedProfile?: string,
): string | undefined {
  return typeof tools.profile === "string" ? tools.profile : inheritedProfile;
}

function collectProfileConfiguredSectionRepairGrants(params: {
  value: unknown;
  inheritedProfile?: string;
  inheritedAlsoAllow?: string[];
  configuredGrants: string[];
}): string[] {
  const tools = getRecord(params.value);
  if (!tools) {
    return [];
  }
  const profile = resolveToolProfileForMigration(tools, params.inheritedProfile);
  if (!profile || profile === "full") {
    return [];
  }
  const ownAllow = readToolPolicyGrantList(tools, "allow");
  if (ownAllow.length === 0) {
    return [];
  }
  const explicitAlsoAllow = readOwnToolPolicyGrantList(tools, "alsoAllow");
  const explicitPolicy = {
    allow: uniqueStrings([...ownAllow, ...(explicitAlsoAllow ?? [])]),
  };
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    explicitAlsoAllow ?? params.inheritedAlsoAllow ?? [],
  );
  return uniqueStrings(
    params.configuredGrants.filter(
      (toolName) =>
        isToolAllowedByPolicyName(toolName, explicitPolicy) &&
        (!isToolAllowedByPolicyName(toolName, profilePolicy) ||
          (explicitAlsoAllow
            ? isToolAllowedByPolicyName(toolName, { allow: explicitAlsoAllow })
            : false)),
    ),
  );
}

function toolProfileConfiguredSectionsNeedExplicitRepair(
  value: unknown,
  inheritedProfile?: string,
  inheritedAlsoAllow?: string[],
  configuredGrantsOverride?: string[],
  inheritedByProvider?: Record<string, unknown> | null,
): boolean {
  const tools = getRecord(value);
  if (!tools) {
    return false;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  return (
    collectProfileConfiguredSectionRepairGrants({
      value,
      inheritedProfile,
      inheritedAlsoAllow,
      configuredGrants,
    }).length > 0 ||
    byProviderToolProfilesNeedConfiguredSectionMigration(
      tools,
      configuredGrants,
      readOwnToolPolicyGrantList(tools, "alsoAllow") ?? inheritedAlsoAllow,
      inheritedByProvider,
    )
  );
}

function collectConfiguredToolSectionGrants(tools: Record<string, unknown>): string[] {
  const grants: string[] = [];
  for (const section of CONFIGURED_TOOL_SECTION_GRANTS) {
    if (getRecord(tools[section.key])) {
      grants.push(...section.grants);
    }
  }
  return uniqueStrings(grants);
}

function collectEffectiveConfiguredToolSectionGrants(
  inheritedTools: Record<string, unknown> | null | undefined,
  tools: Record<string, unknown> | null | undefined,
): string[] {
  const includeInheritedSections = typeof tools?.profile !== "string";
  return uniqueStrings([
    ...(includeInheritedSections && inheritedTools
      ? collectConfiguredToolSectionGrants(inheritedTools)
      : []),
    ...(tools ? collectConfiguredToolSectionGrants(tools) : []),
  ]);
}

function resolveProfileBoundAllowGrants(params: {
  tools: Record<string, unknown>;
  profile: string;
  allow: string[];
  inheritedAlsoAllow?: string[];
  configuredGrants: string[];
}): string[] {
  const explicitAlsoAllow = readOwnToolPolicyGrantList(params.tools, "alsoAllow");
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(params.profile),
    explicitAlsoAllow ?? params.inheritedAlsoAllow ?? [],
  );
  const profileAllow = expandToolGroups(profilePolicy?.allow);
  const coreAllow = profileAllow.includes("*")
    ? expandToolGroups(params.allow)
    : profileAllow.filter((toolName) =>
        isToolAllowedByPolicyName(toolName, { allow: params.allow }),
      );
  const pluginAllow = expandToolGroups(params.allow).filter((entry) => {
    if (entry === "*" || isKnownCoreToolId(entry)) {
      return false;
    }
    return !profileAllow.some((toolName) =>
      isToolAllowedByPolicyName(toolName, { allow: [entry] }),
    );
  });
  return uniqueStrings([...coreAllow, ...pluginAllow, ...params.configuredGrants]);
}

function byProviderToolProfilesNeedConfiguredSectionMigration(
  tools: Record<string, unknown>,
  configuredGrants: string[],
  inheritedAlsoAllow?: string[],
  inheritedByProvider?: Record<string, unknown> | null,
): boolean {
  const byProvider = getRecord(tools.byProvider);
  const ownProviderNeedsMigration = Boolean(
    byProvider &&
    Object.entries(byProvider).some(([providerKey, policy]) => {
      const inheritedProviderPolicy = resolveInheritedProviderPolicy(
        inheritedByProvider,
        providerKey,
      );
      const inheritedProviderProfile =
        typeof inheritedProviderPolicy?.profile === "string"
          ? inheritedProviderPolicy.profile
          : undefined;
      const hasProviderProfile =
        typeof getRecord(policy)?.profile === "string" || Boolean(inheritedProviderProfile);
      if (!hasProviderProfile) {
        return false;
      }
      return (
        collectProfileConfiguredSectionRepairGrants({
          value: policy,
          inheritedProfile: inheritedProviderProfile,
          inheritedAlsoAllow:
            readOwnToolPolicyGrantList(inheritedProviderPolicy, "alsoAllow") ?? inheritedAlsoAllow,
          configuredGrants,
        }).length > 0
      );
    }),
  );
  if (ownProviderNeedsMigration) {
    return true;
  }
  const localConfiguredGrants = collectConfiguredToolSectionGrants(tools);
  if (localConfiguredGrants.length === 0) {
    return false;
  }
  const handledProviders = new Set(
    Object.keys(byProvider ?? {}).map((providerKey) => normalizeToolProviderPolicyKey(providerKey)),
  );
  return listInheritedProviderPoliciesWithProfiles(inheritedByProvider).some(
    (inheritedProvider) =>
      !handledProviders.has(inheritedProvider.normalizedKey) &&
      collectProfileConfiguredSectionRepairGrants({
        value: {},
        inheritedProfile: inheritedProvider.profile,
        inheritedAlsoAllow: readOwnToolPolicyGrantList(inheritedProvider.policy, "alsoAllow"),
        configuredGrants: localConfiguredGrants,
      }).length > 0,
  );
}

function addProfileConfiguredSectionGrants(
  value: unknown,
  pathLabel: string,
  changes: string[],
  inheritedProfile?: string,
  inheritedAlsoAllow?: string[],
  configuredGrantsOverride?: string[],
  materializeProfile = true,
): void {
  const tools = getRecord(value);
  if (!tools || !materializeProfile) {
    return;
  }
  const profile = resolveToolProfileForMigration(tools, inheritedProfile);
  if (!profile) {
    return;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  const repairGrants = collectProfileConfiguredSectionRepairGrants({
    value: tools,
    inheritedProfile,
    inheritedAlsoAllow,
    configuredGrants,
  });
  const allow = readToolPolicyGrantList(tools, "allow");
  if (repairGrants.length === 0 || allow.length === 0 || profile === "full") {
    return;
  }
  const ownAlsoAllow = readOwnToolPolicyGrantList(tools, "alsoAllow");
  tools.allow = resolveProfileBoundAllowGrants({
    tools,
    profile,
    allow: uniqueStrings([...allow, ...(ownAlsoAllow ?? [])]),
    inheritedAlsoAllow,
    configuredGrants: repairGrants,
  });
  changes.push(
    `Replaced ${pathLabel}.allow entries with profile "${profile}" grants plus explicit configured-section grants.`,
  );
  if (ownAlsoAllow) {
    delete tools.alsoAllow;
    changes.push(`Merged ${pathLabel}.alsoAllow into ${pathLabel}.allow.`);
  }
  tools.profile = "full";
  changes.push(
    `Set ${pathLabel}.profile to "full" so ${pathLabel}.allow controls explicit configured-section grants directly.`,
  );
}

function addByProviderProfileConfiguredSectionGrants(
  value: unknown,
  pathLabel: string,
  changes: string[],
  configuredGrantsOverride?: string[],
  inheritedProfile?: string,
  inheritedByProvider?: Record<string, unknown> | null,
): void {
  const tools = getRecord(value);
  if (!tools) {
    return;
  }
  const configuredGrants = configuredGrantsOverride ?? collectConfiguredToolSectionGrants(tools);
  if (configuredGrants.length === 0) {
    return;
  }
  const byProvider = getRecord(tools.byProvider);
  const handledProviders = new Set<string>();
  for (const [providerKey, providerPolicy] of Object.entries(byProvider ?? {})) {
    if (isBlockedObjectKey(providerKey)) {
      continue;
    }
    addHandledProviderPolicyKey(handledProviders, providerKey);
    const inheritedProviderPolicy = resolveInheritedProviderPolicy(
      inheritedByProvider,
      providerKey,
    );
    const ownsProviderProfile = typeof getRecord(providerPolicy)?.profile === "string";
    const inheritedProviderProfile =
      typeof inheritedProviderPolicy?.profile === "string"
        ? inheritedProviderPolicy.profile
        : undefined;
    const providerInheritedProfile = inheritedProviderProfile ?? inheritedProfile;
    const providerInheritedAlsoAllow = readOwnToolPolicyGrantList(
      inheritedProviderPolicy,
      "alsoAllow",
    );
    addProfileConfiguredSectionGrants(
      providerPolicy,
      `${pathLabel}.byProvider.${providerKey}`,
      changes,
      providerInheritedProfile,
      providerInheritedAlsoAllow,
      configuredGrants,
      ownsProviderProfile || Boolean(inheritedProviderProfile),
    );
  }
  const localConfiguredGrants = collectConfiguredToolSectionGrants(tools);
  if (localConfiguredGrants.length === 0) {
    return;
  }
  for (const inheritedProvider of listInheritedProviderPoliciesWithProfiles(inheritedByProvider)) {
    if (handledProviders.has(inheritedProvider.normalizedKey)) {
      continue;
    }
    const providerPolicy: Record<string, unknown> = {};
    const changeCount = changes.length;
    addProfileConfiguredSectionGrants(
      providerPolicy,
      `${pathLabel}.byProvider.${inheritedProvider.key}`,
      changes,
      inheritedProvider.profile,
      readOwnToolPolicyGrantList(inheritedProvider.policy, "alsoAllow"),
      localConfiguredGrants,
    );
    if (changes.length > changeCount) {
      if (!getRecord(tools.byProvider)) {
        tools.byProvider = {};
      }
      getRecord(tools.byProvider)![inheritedProvider.key] = providerPolicy;
      addHandledProviderPolicyKey(handledProviders, inheritedProvider.normalizedKey);
    }
  }
}

function addHandledProviderPolicyKey(handledProviders: Set<string>, providerKey: string): void {
  handledProviders.add(normalizeToolProviderPolicyKey(providerKey));
}

function buildInheritedProviderPolicyLookup(
  inheritedByProvider: Record<string, unknown> | null | undefined,
): Map<
  string,
  {
    key: string;
    policy: Record<string, unknown>;
    canonical: boolean;
  }
> {
  const lookup = new Map<
    string,
    {
      key: string;
      policy: Record<string, unknown>;
      canonical: boolean;
    }
  >();
  for (const [key, value] of Object.entries(inheritedByProvider ?? {})) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    const policy = getRecord(value);
    if (!policy) {
      continue;
    }
    const normalized = normalizeToolProviderPolicyKey(key);
    if (!normalized) {
      continue;
    }
    const canonical = isCanonicalToolProviderPolicyKey(key);
    const existing = lookup.get(normalized);
    if (!existing || (canonical && !existing.canonical)) {
      lookup.set(normalized, { key, policy, canonical });
    }
  }
  return lookup;
}

function resolveInheritedProviderPolicy(
  inheritedByProvider: Record<string, unknown> | null | undefined,
  providerKey: string,
): Record<string, unknown> | null {
  const lookup = buildInheritedProviderPolicyLookup(inheritedByProvider);
  const normalized = normalizeToolProviderPolicyKey(providerKey);
  const slashIndex = normalized.indexOf("/");
  const candidates = slashIndex > 0 ? [normalized, normalized.slice(0, slashIndex)] : [normalized];
  for (const candidate of candidates) {
    const match = lookup.get(candidate);
    if (match) {
      return match.policy;
    }
  }
  return null;
}

function listInheritedProviderPoliciesWithProfiles(
  inheritedByProvider: Record<string, unknown> | null | undefined,
): Array<{
  key: string;
  normalizedKey: string;
  policy: Record<string, unknown>;
  profile: string;
}> {
  const entries: Array<{
    key: string;
    normalizedKey: string;
    policy: Record<string, unknown>;
    profile: string;
  }> = [];
  for (const [normalizedKey, match] of buildInheritedProviderPolicyLookup(inheritedByProvider)) {
    if (typeof match.policy.profile !== "string") {
      continue;
    }
    entries.push({
      key: match.key,
      normalizedKey,
      policy: match.policy,
      profile: match.policy.profile,
    });
  }
  return entries;
}

/** Legacy config migration specs for agent/runtime-owned config keys. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tools.profile-configured-sections-alsoAllow",
    describe: "Repair explicit configured-section tool grants filtered by profiles",
    legacyRules: PROFILE_CONFIGURED_TOOL_SECTION_RULES,
    apply: (raw, changes) => {
      const globalTools = getRecord(raw.tools);
      const inheritedProfile =
        typeof globalTools?.profile === "string" ? globalTools.profile : undefined;
      const inheritedAlsoAllow = readToolPolicyGrantList(globalTools, "alsoAllow");
      addProfileConfiguredSectionGrants(raw.tools, "tools", changes);
      addByProviderProfileConfiguredSectionGrants(
        raw.tools,
        "tools",
        changes,
        undefined,
        inheritedProfile,
      );
      const agents = getRecord(raw.agents);
      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, agent] of agents.list.entries()) {
        const agentTools = getRecord(getRecord(agent)?.tools);
        const configuredGrants = collectEffectiveConfiguredToolSectionGrants(
          globalTools,
          agentTools,
        );
        addProfileConfiguredSectionGrants(
          agentTools,
          `agents.list.${index}.tools`,
          changes,
          inheritedProfile,
          inheritedAlsoAllow,
          configuredGrants,
        );
        addByProviderProfileConfiguredSectionGrants(
          agentTools,
          `agents.list.${index}.tools`,
          changes,
          configuredGrants,
          resolveToolProfileForMigration(agentTools ?? {}, inheritedProfile),
          getRecord(globalTools?.byProvider),
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "silentReplyRewrite-removed",
    describe: "Remove legacy silent reply rewrite and direct-chat silent reply config",
    legacyRules: SILENT_REPLY_LEGACY_RULES,
    apply: removeLegacySilentReplyConfig,
  }),
  defineLegacyConfigMigration({
    id: "agents.systemPromptOverride-removed",
    describe: "Remove legacy agent system prompt override config",
    legacyRules: SYSTEM_PROMPT_OVERRIDE_LEGACY_RULES,
    apply: removeLegacySystemPromptOverride,
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
    id: "agents.model.timeoutMs-ignored",
    describe: "Remove ignored timeoutMs keys from agent model selection config",
    legacyRules: IGNORED_AGENT_MODEL_TIMEOUT_RULES,
    apply: (raw, changes) =>
      migrateAgentDefaultsAndList(raw, changes, removeIgnoredAgentModelTimeouts),
  }),
  defineLegacyConfigMigration({
    id: "agents.embeddedPi->embeddedAgent",
    describe: "Move legacy embedded agent config key to embeddedAgent",
    legacyRules: DEPRECATED_EMBEDDED_AGENT_KEY_RULES,
    apply: (raw, changes) =>
      migrateAgentDefaultsAndList(raw, changes, migrateLegacyEmbeddedAgentKey),
  }),
  defineLegacyConfigMigration({
    id: "agents.agentRuntime-ignored",
    describe: "Remove ignored agent-wide runtime policy",
    legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
    apply: (raw, changes) =>
      migrateAgentDefaultsAndList(raw, changes, removeLegacyAgentRuntimePolicy),
  }),
  defineLegacyConfigMigration({
    id: "agents.sandbox.perSession->scope",
    describe: "Move legacy agent sandbox perSession aliases to sandbox.scope",
    legacyRules: LEGACY_SANDBOX_SCOPE_RULES,
    apply: (raw, changes) =>
      migrateAgentDefaultsAndList(raw, changes, (agent, pathLabel, agentChanges) => {
        const sandbox = getRecord(agent.sandbox);
        if (sandbox) {
          migrateLegacySandboxPerSession(sandbox, `${pathLabel}.sandbox`, agentChanges);
        }
      }),
  }),
  defineLegacyConfigMigration({
    id: "agents.sandbox.browser.network-none",
    describe: "Disable sandbox browser sidecars that use unsupported network mode none",
    legacyRules: UNSUPPORTED_SANDBOX_BROWSER_NETWORK_RULES,
    apply: migrateUnsupportedSandboxBrowserNetworks,
  }),
  defineLegacyConfigMigration({
    id: "memorySearch->memory.search",
    describe: "Move memory search config to its canonical memory owner",
    legacyRules: [MEMORY_SEARCH_RULE, ...AGENT_MEMORY_SEARCH_OWNER_RULES],
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      const legacyDefaults = getRecord(defaults?.memorySearch);
      const legacyTopLevel = getRecord(raw.memorySearch);
      const memory = getRecord(raw.memory);
      const canonical = getRecord(memory?.search);

      if (legacyDefaults || legacyTopLevel) {
        const target = structuredClone(canonical ?? {});
        if (legacyDefaults) {
          mergeMissing(target, legacyDefaults);
          delete defaults!.memorySearch;
        }
        if (legacyTopLevel) {
          mergeMissing(target, legacyTopLevel);
          delete raw.memorySearch;
        }
        ensureRecord(raw, "memory").search = target;
        changes.push(
          canonical
            ? "Merged legacy memorySearch defaults → memory.search (kept explicit memory.search values)."
            : "Moved legacy memorySearch defaults → memory.search.",
        );
      }

      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, rawAgent] of agents.list.entries()) {
        const agent = getRecord(rawAgent);
        const legacy = getRecord(agent?.memorySearch);
        if (!agent || !legacy) {
          continue;
        }
        const agentMemory = ensureRecord(agent, "memory");
        const existing = getRecord(agentMemory.search);
        const target = structuredClone(existing ?? {});
        mergeMissing(target, legacy);
        agentMemory.search = target;
        delete agent.memorySearch;
        changes.push(
          existing
            ? `Merged agents.list.${index}.memorySearch → agents.list.${index}.memory.search (kept explicit memory.search values).`
            : `Moved agents.list.${index}.memorySearch → agents.list.${index}.memory.search.`,
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "memorySearch.flat-fields->nested-fields",
    describe: "Move legacy flat memory search fields to canonical nested fields",
    legacyRules: LEGACY_MEMORY_SEARCH_FLAT_KEY_RULES,
    apply: (raw, changes) =>
      migrateCanonicalMemorySearches(raw, changes, migrateLegacyMemorySearchFlatKeys),
  }),
  defineLegacyConfigMigration({
    id: "memorySearch.provider-auto->openai",
    describe: 'Rewrite legacy memorySearch provider "auto" to "openai"',
    legacyRules: LEGACY_MEMORY_SEARCH_AUTO_PROVIDER_RULES,
    apply: (raw, changes) =>
      migrateCanonicalMemorySearches(raw, changes, rewriteLegacyMemorySearchAutoProvider),
  }),
  defineLegacyConfigMigration({
    id: "memorySearch.store.path->agent-database",
    describe: "Remove legacy memory search sidecar index paths",
    legacyRules: LEGACY_MEMORY_SEARCH_STORE_PATH_RULES,
    apply: (raw, changes) =>
      migrateCanonicalMemorySearches(raw, changes, removeLegacyMemorySearchStorePath, "brackets"),
  }),
  defineLegacyConfigMigration({
    id: "session.typingMode->agents.defaults.typingMode",
    describe: "Move session typing mode to agent defaults",
    legacyRules: [
      {
        path: ["session", "typingMode"],
        message:
          'session.typingMode moved to agents.defaults.typingMode. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.hasOwn(session, "typingMode")) {
        return;
      }
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      const replacedDefault = defaults.typingMode !== undefined;
      defaults.typingMode = session.typingMode;
      changes.push(
        replacedDefault
          ? "Moved session.typingMode → agents.defaults.typingMode (replaced the previously shadowed agent default)."
          : "Moved session.typingMode → agents.defaults.typingMode.",
      );
      delete session.typingMode;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
