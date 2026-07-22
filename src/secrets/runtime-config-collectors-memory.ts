/** Collects per-agent memory search secret refs from runtime config. */
import { type ListedAgentEntry, listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { runtimeMemorySecretOwnerId } from "./runtime-memory-secret-owner.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

/** Collects memory-search SecretRefs once for every agent that can inherit them. */
export function collectAgentMemorySearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const memory = params.config.memory as Record<string, unknown> | undefined;
  const defaultsMemorySearch = isRecord(memory?.search) ? memory.search : undefined;
  const entries = listAgentEntriesWithSource(params.config);
  const defaultRemote = isRecord(defaultsMemorySearch?.remote)
    ? defaultsMemorySearch.remote
    : undefined;
  const defaultHeaders = isRecord(defaultRemote?.headers) ? defaultRemote.headers : undefined;
  let defaultApiKeyAssignmentCollected = false;
  const collectedDefaultHeaderKeys = new Set<string>();
  const collectForAgent = ({ entry: rawAgent, source }: ListedAgentEntry) => {
    const rawAgentRecord = rawAgent as unknown as Record<string, unknown>;
    const agentMemory = isRecord(rawAgentRecord.memory) ? rawAgentRecord.memory : undefined;
    const memorySearch = isRecord(agentMemory?.search) ? agentMemory.search : undefined;
    const remote = isRecord(memorySearch?.remote) ? memorySearch.remote : undefined;
    const agentId = normalizeAgentId(rawAgent.id);
    const agentPath =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    const active =
      rawAgentRecord.enabled !== false &&
      (memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true) !== false;
    const owner = {
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId(agentId),
      requiredForGateway: false,
      disposition: "isolate",
      contract: {
        defaults: defaultsMemorySearch,
        override: memorySearch,
        agentEnabled: rawAgentRecord.enabled,
      },
    } satisfies SecretAssignmentOwner;

    const hasApiKeyOverride = Boolean(remote && Object.hasOwn(remote, "apiKey"));
    const apiKeyTarget = hasApiKeyOverride ? remote : defaultRemote;
    if (apiKeyTarget && Object.hasOwn(apiKeyTarget, "apiKey")) {
      collectRuntimeSecretInputAssignment({
        value: apiKeyTarget.apiKey,
        path: hasApiKeyOverride
          ? `${agentPath}.memory.search.remote.apiKey`
          : "memory.search.remote.apiKey",
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason: "agent or memorySearch override is disabled.",
        owner,
        apply: (value) => {
          apiKeyTarget.apiKey = value;
        },
      });
      if (!hasApiKeyOverride && active) {
        defaultApiKeyAssignmentCollected = true;
      }
    }

    const overrideHeaders = isRecord(remote?.headers) ? remote.headers : undefined;
    const headerTarget = overrideHeaders ?? defaultHeaders;
    if (!headerTarget) {
      return;
    }
    for (const [headerKey, headerValue] of Object.entries(headerTarget)) {
      collectRuntimeSecretInputAssignment({
        value: headerValue,
        path: overrideHeaders
          ? `${agentPath}.memory.search.remote.headers.${headerKey}`
          : `memory.search.remote.headers.${headerKey}`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason: "agent or memorySearch override is disabled.",
        owner,
        apply: (value) => {
          headerTarget[headerKey] = value;
        },
      });
      if (!overrideHeaders && active) {
        collectedDefaultHeaderKeys.add(headerKey);
      }
    }
  };

  entries.forEach(collectForAgent);

  if (defaultRemote && !defaultApiKeyAssignmentCollected) {
    collectRuntimeSecretInputAssignment({
      value: defaultRemote.apiKey,
      path: "memory.search.remote.apiKey",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: false,
      inactiveReason: "no enabled agent inherits this memorySearch remote api key.",
      apply: (value) => {
        defaultRemote.apiKey = value;
      },
    });
  }
  for (const [headerKey, headerValue] of Object.entries(defaultHeaders ?? {})) {
    if (collectedDefaultHeaderKeys.has(headerKey)) {
      continue;
    }
    collectRuntimeSecretInputAssignment({
      value: headerValue,
      path: `memory.search.remote.headers.${headerKey}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: false,
      inactiveReason: "no enabled agent inherits this memorySearch remote header.",
      apply: (value) => {
        defaultHeaders![headerKey] = value;
      },
    });
  }
}
