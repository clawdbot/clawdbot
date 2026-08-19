import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalAgentRuntimeId } from "../../../agents/agent-runtime-id.js";
import { getRecord, type LegacyConfigRule } from "../../../config/legacy.shared.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import {
  isLegacyCodexProviderId,
  legacyCodexProviderIdentityKey,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  MODEL_REF_CANONICALIZATION_MESSAGE,
  hasOwnDefinedProperty,
  scanKnownModelRefs,
} from "./legacy-config-migrations.runtime.models.refs.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";

export const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";
const MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS = [
  "apiKey",
  "auth",
  "request",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "localService",
  "headers",
  "authHeader",
] as const;
const CANONICAL_PROVIDER_MODEL_LEAK_KEYS = [
  "apiKey",
  "auth",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "params",
  "agentRuntime",
  "localService",
  "headers",
  "authHeader",
  "request",
] as const;

function hasCanonicalOpenAIProvider(providers: Record<string, unknown>): boolean {
  return Object.keys(providers).some(
    (providerId) => normalizeProviderId(providerId) === OPENAI_PROVIDER_ID,
  );
}

function normalizeLegacyOpenAIResponsesApi(
  providerId: string,
  provider: Record<string, unknown>,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...provider };
  if (next.api === LEGACY_OPENAI_CODEX_RESPONSES_API) {
    next.api = OPENAI_CHATGPT_RESPONSES_API;
    changes.push(
      `Moved models.providers.${providerId}.api "${LEGACY_OPENAI_CODEX_RESPONSES_API}" → "${OPENAI_CHATGPT_RESPONSES_API}".`,
    );
    changed = true;
  }
  if (Array.isArray(provider.models)) {
    let modelsChanged = false;
    const nextModels = provider.models.map((model, index) => {
      const modelRecord = getRecord(model);
      if (!modelRecord || modelRecord.api !== LEGACY_OPENAI_CODEX_RESPONSES_API) {
        return model;
      }
      modelsChanged = true;
      changes.push(
        `Moved models.providers.${providerId}.models[${index}].api "${LEGACY_OPENAI_CODEX_RESPONSES_API}" → "${OPENAI_CHATGPT_RESPONSES_API}".`,
      );
      return {
        ...modelRecord,
        api: OPENAI_CHATGPT_RESPONSES_API,
      };
    });
    if (modelsChanged) {
      next.models = nextModels;
      changed = true;
    }
  }
  return { value: next, changed };
}

function collectModelMergeBlockers(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
  legacyProviderId: string;
}): string[] {
  const blockers: string[] = [];
  for (const key of MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS) {
    if (hasOwnDefinedProperty(params.legacy, key)) {
      blockers.push(`models.providers.${params.legacyProviderId}.${key}`);
    }
  }
  for (const key of CANONICAL_PROVIDER_MODEL_LEAK_KEYS) {
    if (hasOwnDefinedProperty(params.canonical, key)) {
      blockers.push(`models.providers.${OPENAI_PROVIDER_ID}.${key}`);
    }
  }
  return blockers;
}

function getCanonicalOpenAIProviderEntry(
  providers: Record<string, unknown>,
): { key: string; value: Record<string, unknown> } | undefined {
  const key = Object.keys(providers).find((k) => normalizeProviderId(k) === OPENAI_PROVIDER_ID);
  const value = key ? getRecord(providers[key]) : undefined;
  return key && value ? { key, value } : undefined;
}

function getMergeableLegacyOpenAIModels(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
}): unknown[] {
  const legacyModels: unknown[] = Array.isArray(params.legacy.models)
    ? (params.legacy.models as unknown[])
    : [];
  const canonicalModels: unknown[] = Array.isArray(params.canonical.models)
    ? (params.canonical.models as unknown[])
    : [];
  const canonicalModelIds = new Set<string>();
  const canonicalModelNames = new Set<string>();
  for (const m of canonicalModels) {
    const mr = getRecord(m);
    if (typeof mr?.id === "string" && mr.id) {
      canonicalModelIds.add(mr.id);
    }
    if (typeof mr?.name === "string" && mr.name) {
      canonicalModelNames.add(mr.name);
    }
  }
  return legacyModels.filter((m) => {
    const mr = getRecord(m);
    if (!mr) {
      return false;
    }
    const id = typeof mr.id === "string" ? mr.id : undefined;
    const name = typeof mr.name === "string" ? mr.name : undefined;
    if (!id && !name) {
      return false;
    }
    return id ? !canonicalModelIds.has(id) : name ? !canonicalModelNames.has(name) : false;
  });
}

function collectLegacyModelPolicyWildcardPaths(raw: unknown): Map<string, string[]> {
  const pathsByProvider = new Map<string, string[]>();
  const agents = getRecord(getRecord(raw)?.agents);
  const scopes: Array<{ value: unknown; path: string }> = [
    { value: getRecord(agents?.defaults)?.modelPolicy, path: "agents.defaults.modelPolicy" },
  ];
  const list = Array.isArray(agents?.list) ? agents.list : [];
  for (const [index, agent] of list.entries()) {
    scopes.push({
      value: getRecord(agent)?.modelPolicy,
      path: `agents.list.${index}.modelPolicy`,
    });
  }
  for (const scope of scopes) {
    const allow = getRecord(scope.value)?.allow;
    if (!Array.isArray(allow)) {
      continue;
    }
    for (const [index, entry] of allow.entries()) {
      if (typeof entry !== "string" || !entry.trim().endsWith("/*")) {
        continue;
      }
      const provider = normalizeProviderId(entry.trim().slice(0, -2));
      if (!isLegacyCodexProviderId(provider)) {
        continue;
      }
      const paths = pathsByProvider.get(provider) ?? [];
      paths.push(`${scope.path}.allow.${index}`);
      pathsByProvider.set(provider, paths);
    }
  }
  return pathsByProvider;
}

export function hasAutoFixableLegacyOpenAICodexProvider(
  providersValue: unknown,
  root?: Record<string, unknown>,
): boolean {
  const providers = getRecord(providersValue);
  if (!providers) {
    return false;
  }
  const wildcardPaths = collectLegacyModelPolicyWildcardPaths(root);
  const canonicalEntry = getCanonicalOpenAIProviderEntry(providers);
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !isLegacyCodexProviderId(providerId)) {
      continue;
    }
    if (wildcardPaths.has(normalizeProviderId(providerId))) {
      continue;
    }
    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, []);
    if (normalized.changed || !canonicalEntry) {
      return true;
    }
    const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (modelCollisions.length > 0) {
      continue;
    }
    const modelsToMerge = getMergeableLegacyOpenAIModels({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
    });
    if (modelsToMerge.length === 0) {
      return true;
    }
    const mergeBlockers = collectModelMergeBlockers({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (mergeBlockers.length === 0) {
      return true;
    }
  }
  return false;
}

export type BlockedLegacyOpenAICodexProviderPlan = {
  blockedModelIdentities: LegacyCodexModelIdentity[];
  warning?: string;
};

/** Compute the provider-merge blockers once so every doctor state repair shares the decision. */
export function collectBlockedLegacyOpenAICodexProviderPlan(
  raw: unknown,
): BlockedLegacyOpenAICodexProviderPlan {
  const models = getRecord(getRecord(raw)?.models);
  const providers = getRecord(models?.providers);
  const canonicalEntry = providers ? getCanonicalOpenAIProviderEntry(providers) : undefined;
  const blockedModelIdentities = new Set<LegacyCodexModelIdentity>();
  const warningLines: string[] = [];
  for (const [providerId, paths] of collectLegacyModelPolicyWildcardPaths(raw)) {
    const identity = legacyCodexProviderIdentityKey(providerId);
    if (identity) {
      blockedModelIdentities.add(identity);
    }
    warningLines.push(
      `- ${paths.join(", ")} cannot migrate automatically because ${providerId}/* would become openai/* and authorize unrelated OpenAI models.`,
    );
  }
  if (!providers || !canonicalEntry) {
    return buildBlockedLegacyOpenAICodexProviderPlan(blockedModelIdentities, warningLines);
  }
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !isLegacyCodexProviderId(providerId)) {
      continue;
    }
    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, []);
    const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (modelCollisions.length > 0) {
      const identity = legacyCodexProviderIdentityKey(providerId);
      if (identity) {
        blockedModelIdentities.add(identity);
      }
      warningLines.push(
        `- models.providers.${providerId} cannot be merged automatically into models.providers.${canonicalEntry.key} because colliding model definitions differ for: ${modelCollisions.join(", ")}.`,
      );
      continue;
    }
    const modelsToMerge = getMergeableLegacyOpenAIModels({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
    });
    if (modelsToMerge.length === 0) {
      continue;
    }
    const mergeBlockers = collectModelMergeBlockers({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (mergeBlockers.length === 0) {
      continue;
    }
    const identity = legacyCodexProviderIdentityKey(providerId);
    if (identity) {
      blockedModelIdentities.add(identity);
    }
    warningLines.push(
      `- models.providers.${providerId} cannot be merged automatically into models.providers.${canonicalEntry.key} because provider-level defaults cannot be represented safely on merged models: ${mergeBlockers.join(", ")}.`,
    );
  }
  // Intentionally fail closed: retained legacy refs are NOT executable until
  // reconciled (the live codex provider is gone, and a hidden resolver/auth
  // shim is forbidden by policy). Only hand-authored models.providers.codex
  // definitions can reach this state; the warning names the exact repair.
  return buildBlockedLegacyOpenAICodexProviderPlan(blockedModelIdentities, warningLines);
}

function buildBlockedLegacyOpenAICodexProviderPlan(
  blockedModelIdentities: ReadonlySet<LegacyCodexModelIdentity>,
  warningLines: string[],
): BlockedLegacyOpenAICodexProviderPlan {
  return {
    blockedModelIdentities: [...blockedModelIdentities],
    ...(warningLines.length > 0
      ? {
          warning: [
            "Legacy Codex provider routes require manual reconciliation before matching refs can migrate.",
            ...warningLines,
            "- Doctor retained matching legacy refs in config, sessions, and cron. These refs will not execute until reconciled: fix the model route/auth metadata, remove the legacy provider entry, then rerun `openclaw doctor --fix`.",
          ].join("\n"),
        }
      : {}),
  };
}

function resolveMovedCodexModelRuntime(params: {
  legacyProviderId: string;
  legacyProvider: Record<string, unknown>;
  model: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (normalizeProviderId(params.legacyProviderId) !== "codex") {
    return undefined;
  }
  const modelRuntime = getRecord(params.model.agentRuntime);
  const modelRuntimeId = normalizeOptionalAgentRuntimeId(modelRuntime?.id);
  if (modelRuntimeId && modelRuntimeId !== "auto") {
    return undefined;
  }
  if (modelRuntimeId === "auto") {
    return { ...modelRuntime, id: "codex" };
  }
  const providerRuntime = getRecord(params.legacyProvider.agentRuntime);
  const providerRuntimeId = normalizeOptionalAgentRuntimeId(providerRuntime?.id);
  // Converting provider-level auto must keep its sibling policy fields
  // (e.g. fallback: "none"), matching the model-level branch above.
  return providerRuntimeId && providerRuntimeId !== "auto"
    ? (providerRuntime ?? undefined)
    : { ...providerRuntime, id: "codex" };
}

function buildMergedLegacyOpenAIModel(
  model: unknown,
  legacyProvider: Record<string, unknown>,
  legacyProviderId: string,
): unknown {
  const modelRecord = getRecord(model);
  if (!modelRecord) {
    return model;
  }
  const patch: Record<string, unknown> = {};
  const legacyBaseUrl =
    typeof legacyProvider.baseUrl === "string" ? legacyProvider.baseUrl : undefined;
  const legacyApi = typeof legacyProvider.api === "string" ? legacyProvider.api : undefined;
  const legacyParams = getRecord(legacyProvider.params);
  const legacyAgentRuntime = getRecord(legacyProvider.agentRuntime);
  const movedCodexRuntime = resolveMovedCodexModelRuntime({
    legacyProviderId,
    legacyProvider,
    model: modelRecord,
  });
  if (legacyBaseUrl && !modelRecord.baseUrl) {
    patch.baseUrl = legacyBaseUrl;
  }
  if (legacyApi && !modelRecord.api) {
    patch.api = legacyApi;
  }
  for (const key of ["contextWindow", "contextTokens", "maxTokens"] as const) {
    if (typeof legacyProvider[key] === "number" && modelRecord[key] === undefined) {
      patch[key] = legacyProvider[key];
    }
  }
  if (legacyParams) {
    const modelParams = getRecord(modelRecord.params);
    if (modelParams) {
      patch.params = { ...legacyParams, ...modelParams };
    } else if (modelRecord.params === undefined) {
      patch.params = legacyParams;
    }
  }
  if (movedCodexRuntime) {
    patch.agentRuntime = movedCodexRuntime;
  } else if (legacyAgentRuntime && modelRecord.agentRuntime === undefined) {
    patch.agentRuntime = legacyAgentRuntime;
  }
  if (
    modelRecord.metadataSource === undefined &&
    isLegacyModelsAddCodexMetadataModel({
      provider: legacyProviderId,
      model: modelRecord as Partial<ModelDefinitionConfig>,
    })
  ) {
    patch.metadataSource = "models-add";
  }
  return Object.keys(patch).length > 0 ? Object.assign({}, modelRecord, patch) : model;
}

function collectNonEquivalentLegacyOpenAIModelCollisions(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
  legacyProviderId: string;
}): string[] {
  const canonicalModels = Array.isArray(params.canonical.models) ? params.canonical.models : [];
  const legacyModels = Array.isArray(params.legacy.models) ? params.legacy.models : [];
  const conflicts = new Set<string>();
  for (const legacyModel of legacyModels) {
    const legacyRecord = getRecord(legacyModel);
    const legacyId = typeof legacyRecord?.id === "string" ? legacyRecord.id : undefined;
    const legacyName = typeof legacyRecord?.name === "string" ? legacyRecord.name : undefined;
    if (!legacyRecord || (!legacyId && !legacyName)) {
      continue;
    }
    const collisions = canonicalModels.filter((canonicalModel) => {
      const canonicalRecord = getRecord(canonicalModel);
      return legacyId ? canonicalRecord?.id === legacyId : canonicalRecord?.name === legacyName;
    });
    if (collisions.length === 0) {
      continue;
    }
    const legacyEffective = buildMergedLegacyOpenAIModel(
      legacyModel,
      params.legacy,
      params.legacyProviderId,
    );
    const definitionsMatch = collisions.every((canonicalModel) => {
      const canonicalEffective = buildMergedLegacyOpenAIModel(
        canonicalModel,
        params.canonical,
        OPENAI_PROVIDER_ID,
      );
      if (!isDeepStrictEqual(canonicalEffective, legacyEffective)) {
        return false;
      }
      return MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS.every((key) =>
        isDeepStrictEqual(params.canonical[key], params.legacy[key]),
      );
    });
    if (!definitionsMatch) {
      conflicts.add(legacyId ?? legacyName ?? "unknown");
    }
  }
  return [...conflicts];
}

function prepareLegacyCodexProviderForCanonicalMove(
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  if (normalizeProviderId(providerId) !== "codex" || !Array.isArray(provider.models)) {
    return provider;
  }
  return {
    ...provider,
    models: provider.models.map((model) => {
      const record = getRecord(model);
      if (!record) {
        return model;
      }
      const agentRuntime = resolveMovedCodexModelRuntime({
        legacyProviderId: providerId,
        legacyProvider: provider,
        model: record,
      });
      return agentRuntime ? { ...record, agentRuntime } : model;
    }),
  };
}

export function migrateLegacyOpenAICodexProvider(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const models = getRecord(raw.models);
  const providers = getRecord(models?.providers);
  if (!models || !providers) {
    return;
  }
  let providersChanged = false;
  const wildcardPaths = collectLegacyModelPolicyWildcardPaths(raw);
  for (const [providerId, providerValue] of Object.entries({ ...providers })) {
    const provider = getRecord(providers[providerId]) ?? getRecord(providerValue);
    if (!provider) {
      continue;
    }
    if (isLegacyCodexProviderId(providerId) && wildcardPaths.has(normalizeProviderId(providerId))) {
      continue;
    }
    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, changes);
    if (!isLegacyCodexProviderId(providerId)) {
      if (normalized.changed) {
        providers[providerId] = normalized.value;
        providersChanged = true;
      }
      continue;
    }
    if (!hasCanonicalOpenAIProvider(providers)) {
      providers[OPENAI_PROVIDER_ID] = prepareLegacyCodexProviderForCanonicalMove(
        providerId,
        normalized.value,
      );
      changes.push(
        `Moved models.providers.${providerId} → models.providers.${OPENAI_PROVIDER_ID}.`,
      );
    } else {
      // Canonical openai provider already exists. Merge non-conflicting model
      // entries from the legacy provider so disjoint models (e.g. a chat model
      // on the Codex OAuth path alongside an embeddings-only openai provider)
      // are preserved instead of silently dropped. (#90047)
      const canonicalEntry = getCanonicalOpenAIProviderEntry(providers);
      const canonicalKey = canonicalEntry?.key ?? OPENAI_PROVIDER_ID;
      const canonical = canonicalEntry?.value ?? {};
      const canonicalModels: unknown[] = Array.isArray(canonical.models)
        ? (canonical.models as unknown[])
        : [];
      const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
        canonical,
        legacy: normalized.value,
        legacyProviderId: providerId,
      });
      const modelsToMerge = getMergeableLegacyOpenAIModels({
        canonical,
        legacy: normalized.value,
      });
      const mergeBlockers =
        modelCollisions.length === 0 && modelsToMerge.length > 0
          ? collectModelMergeBlockers({
              canonical,
              legacy: normalized.value,
              legacyProviderId: providerId,
            })
          : [];
      if (modelCollisions.length > 0 || mergeBlockers.length > 0) {
        if (normalized.changed) {
          providers[providerId] = normalized.value;
          providersChanged = true;
          changes.push(
            modelCollisions.length > 0
              ? `Skipped merging models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID} because colliding model definitions differ for: ${modelCollisions.join(", ")}.`
              : `Skipped merging models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID} because provider-level defaults cannot be represented safely on merged models: ${mergeBlockers.join(", ")}.`,
          );
        }
        continue;
      }
      // Stamp model-scoped legacy provider defaults onto each merged model so it
      // keeps the Codex endpoint and runtime metadata instead of inheriting the
      // canonical provider's OpenAI platform defaults.
      const stamped = modelsToMerge.map((m) =>
        buildMergedLegacyOpenAIModel(m, normalized.value, providerId),
      );
      if (stamped.length > 0) {
        providers[canonicalKey] = { ...canonical, models: [...canonicalModels, ...stamped] };
        const mergedIds = stamped
          .map((m) => {
            const mr = getRecord(m);
            return typeof mr?.id === "string" && mr.id
              ? mr.id
              : typeof mr?.name === "string" && mr.name
                ? mr.name
                : "unknown";
          })
          .join(", ");
        changes.push(
          `Merged ${stamped.length} model(s) from models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID}: ${mergedIds}.`,
        );
      } else {
        changes.push(
          `Removed models.providers.${providerId} because models.providers.${OPENAI_PROVIDER_ID} already exists.`,
        );
      }
    }
    delete providers[providerId];
    providersChanged = true;
  }
  if (providersChanged) {
    models.providers = providers;
  }
}

export const MODEL_REF_CANONICALIZATION_RULES: LegacyConfigRule[] = [
  "agents",
  "plugins",
  "messages",
  "tools",
  "hooks",
  "channels",
  "models",
].map((section) => ({
  path: [section],
  message: MODEL_REF_CANONICALIZATION_MESSAGE,
  match: (value) => scanKnownModelRefs(value),
}));
