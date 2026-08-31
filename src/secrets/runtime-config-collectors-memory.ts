/** Collects per-agent memory search secret refs from runtime config. */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasAgentRosterProperty,
  type ListedAgentEntry,
  listAgentEntriesWithSource,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "../plugins/embedding-provider-config.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { runtimeMemorySecretOwnerId } from "./runtime-memory-secret-owner.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";

function resolveMemoryEmbeddingProviderContract(params: {
  config: OpenClawConfig;
  context: ResolverContext;
  defaults: Record<string, unknown> | undefined;
  override: Record<string, unknown> | undefined;
}) {
  const configuredProvider =
    normalizeOptionalString(params.override?.provider) ??
    normalizeOptionalString(params.defaults?.provider);
  const providerId =
    !configuredProvider || configuredProvider === "auto"
      ? DEFAULT_MEMORY_EMBEDDING_PROVIDER
      : configuredProvider;
  const lookupIds = new Set(
    [providerId, resolveConfiguredGenericEmbeddingProviderId(providerId, params.config)]
      .filter((id): id is string => Boolean(id))
      .map(normalizeProviderId),
  );
  // Manifest ownership is available before provider registration and stays
  // unchanged afterward, so runtime activation cannot perturb owner digests.
  const credentialOwnerIds = (params.context.manifestRegistry?.plugins ?? []).flatMap((plugin) =>
    plugin.contracts?.embeddingProviders?.some((id) => lookupIds.has(normalizeProviderId(id)))
      ? plugin.providers
      : [],
  );
  const contractProviderIds = new Set(
    [
      providerId,
      ...(credentialOwnerIds.length > 0
        ? credentialOwnerIds
        : Object.keys(params.config.models?.providers ?? {})),
    ].map(normalizeProviderId),
  );
  const providerConfigs = new Map<string, Record<string, unknown>>();
  for (const candidateId of contractProviderIds) {
    const providerConfig = findNormalizedProviderValue(
      params.config.models?.providers,
      candidateId,
    );
    if (providerConfig) {
      providerConfigs.set(candidateId, {
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        auth: providerConfig.auth,
        authHeader: providerConfig.authHeader,
        headers: providerConfig.headers,
        request: providerConfig.request,
        params: providerConfig.params,
        region: providerConfig.region,
        localService: providerConfig.localService,
      });
    }
  }
  return {
    id: providerId,
    config:
      providerConfigs.size === 1
        ? providerConfigs.values().next().value
        : providerConfigs.size > 1
          ? Object.fromEntries(providerConfigs)
          : undefined,
  };
}

/** Collects memory-search SecretRefs once for every agent that can inherit them. */
export function collectAgentMemorySearchAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const memory = params.config.memory as Record<string, unknown> | undefined;
  const defaultsMemorySearch = isRecord(memory?.search) ? memory.search : undefined;
  const configuredEntries = listAgentEntriesWithSource(params.config);
  const entries: ListedAgentEntry[] =
    configuredEntries.length === 0 && !hasAgentRosterProperty(params.config)
      ? [
          {
            entry: { id: LEGACY_IMPLICIT_AGENT_ID, default: true },
            source: { kind: "entries", key: LEGACY_IMPLICIT_AGENT_ID },
          },
        ]
      : configuredEntries;
  const defaultRemote = isRecord(defaultsMemorySearch?.remote)
    ? defaultsMemorySearch.remote
    : undefined;
  const defaultHeaders = isRecord(defaultRemote?.headers) ? defaultRemote.headers : undefined;
  let defaultApiKeyAssignmentCollected = false;
  const collectedDefaultHeaderKeys = new Set<string>();
  const collectForAgent = ({ entry: rawAgent, source }: ListedAgentEntry) => {
    const rawAgentValue: unknown = rawAgent;
    if (!isRecord(rawAgentValue)) {
      return;
    }
    const rawAgentRecord = rawAgentValue;
    const agentMemory = isRecord(rawAgentRecord.memory) ? rawAgentRecord.memory : undefined;
    const memorySearch = isRecord(agentMemory?.search) ? agentMemory.search : undefined;
    const remote = isRecord(memorySearch?.remote) ? memorySearch.remote : undefined;
    const agentId = normalizeAgentId(rawAgent.id);
    const agentPath =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    const active =
      rawAgentRecord["enabled"] !== false &&
      (memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true) !== false;
    const owner = {
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId(agentId),
      requiredForGateway: false,
      disposition: "isolate",
      contract: {
        defaults: defaultsMemorySearch,
        override: memorySearch,
        agentEnabled: rawAgentRecord["enabled"],
        provider: resolveMemoryEmbeddingProviderContract({
          config: params.config,
          context: params.context,
          defaults: defaultsMemorySearch,
          override: memorySearch,
        }),
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
