/** Collects per-agent memory search secret refs from runtime config. */
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
  const agents = params.config.agents as Record<string, unknown> | undefined;
  const memory = params.config.memory as Record<string, unknown> | undefined;
  const defaultsMemorySearch = isRecord(memory?.search) ? memory.search : undefined;
  const canonicalEntries = isRecord(agents?.entries) ? Object.entries(agents.entries) : [];
  const legacyEntries = Array.isArray(agents?.list)
    ? agents.list.flatMap((value, index) => {
        if (!isRecord(value)) {
          return [];
        }
        const id = typeof value.id === "string" ? value.id : String(index);
        return [[id, value, "list", String(index)] as const];
      })
    : [];
  const entries =
    canonicalEntries.length > 0
      ? canonicalEntries.map(([id, value]) => [id, value, "entries", id] as const)
      : legacyEntries;
  const defaultRemote = isRecord(defaultsMemorySearch?.remote)
    ? defaultsMemorySearch.remote
    : undefined;
  const defaultHeaders = isRecord(defaultRemote?.headers) ? defaultRemote.headers : undefined;
  let defaultApiKeyAssignmentCollected = false;
  const collectedDefaultHeaderKeys = new Set<string>();
  const collectForAgent = (
    rawAgent: Record<string, unknown>,
    entryId: string,
    container = "entries",
    pathId = entryId,
  ) => {
    const agentMemory = isRecord(rawAgent.memory) ? rawAgent.memory : undefined;
    const memorySearch = isRecord(agentMemory?.search) ? agentMemory.search : undefined;
    const remote = isRecord(memorySearch?.remote) ? memorySearch.remote : undefined;
    const agentId = normalizeAgentId(entryId);
    const active =
      rawAgent?.enabled !== false &&
      (memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true) !== false;
    const owner = {
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId(agentId),
      requiredForGateway: false,
      disposition: "isolate",
      contract: {
        defaults: defaultsMemorySearch,
        override: memorySearch,
        agentEnabled: rawAgent?.enabled,
      },
    } satisfies SecretAssignmentOwner;

    const hasApiKeyOverride = Boolean(remote && Object.hasOwn(remote, "apiKey"));
    const apiKeyTarget = hasApiKeyOverride ? remote : defaultRemote;
    if (apiKeyTarget && Object.hasOwn(apiKeyTarget, "apiKey")) {
      collectRuntimeSecretInputAssignment({
        value: apiKeyTarget.apiKey,
        path: hasApiKeyOverride
          ? `agents.${container}.${pathId}.memory.search.remote.apiKey`
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
          ? `agents.${container}.${pathId}.memory.search.remote.headers.${headerKey}`
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

  entries.forEach(([entryId, rawAgent, container, pathId]) => {
    if (isRecord(rawAgent)) {
      collectForAgent(rawAgent, entryId, container, pathId);
    }
  });

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
