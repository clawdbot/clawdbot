/** Collects per-agent memory search secret refs from runtime config. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
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
  if (!isRecord(agents)) {
    return;
  }
  const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch)
    ? defaultsConfig.memorySearch
    : undefined;
  const list = Array.isArray(agents.list) ? agents.list : [];
  const defaultRemote = isRecord(defaultsMemorySearch?.remote)
    ? defaultsMemorySearch.remote
    : undefined;
  const defaultHeaders = isRecord(defaultRemote?.headers) ? defaultRemote.headers : undefined;
  let defaultApiKeyAssignmentCollected = false;
  const collectedDefaultHeaderKeys = new Set<string>();
  const collectForAgent = (rawAgent: Record<string, unknown> | undefined, index?: number) => {
    const memorySearch = isRecord(rawAgent?.memorySearch) ? rawAgent.memorySearch : undefined;
    const remote = isRecord(memorySearch?.remote) ? memorySearch.remote : undefined;
    const agentId = normalizeAgentId(
      typeof rawAgent?.id === "string" ? rawAgent.id : DEFAULT_AGENT_ID,
    );
    const active =
      rawAgent?.enabled !== false &&
      (memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true) !== false;
    const owner = {
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId(agentId),
      requiredForGateway: false,
      disposition: "isolate",
    } satisfies SecretAssignmentOwner;

    const hasApiKeyOverride = Boolean(remote && Object.hasOwn(remote, "apiKey"));
    const apiKeyTarget = hasApiKeyOverride ? remote : defaultRemote;
    if (apiKeyTarget && Object.hasOwn(apiKeyTarget, "apiKey")) {
      collectRuntimeSecretInputAssignment({
        value: apiKeyTarget.apiKey,
        path: hasApiKeyOverride
          ? `agents.list.${index}.memorySearch.remote.apiKey`
          : "agents.defaults.memorySearch.remote.apiKey",
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
          ? `agents.list.${index}.memorySearch.remote.headers.${headerKey}`
          : `agents.defaults.memorySearch.remote.headers.${headerKey}`,
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

  if (list.length === 0) {
    collectForAgent(undefined);
  } else {
    list.forEach((rawAgent, index) => {
      if (isRecord(rawAgent)) {
        collectForAgent(rawAgent, index);
      }
    });
  }

  if (defaultRemote && !defaultApiKeyAssignmentCollected) {
    collectRuntimeSecretInputAssignment({
      value: defaultRemote.apiKey,
      path: "agents.defaults.memorySearch.remote.apiKey",
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
      path: `agents.defaults.memorySearch.remote.headers.${headerKey}`,
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
