import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import {
  isBlockedLegacyCodexModelRef,
  normalizeRuntimeString,
  toCanonicalOpenAIModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import type { CodexRouteHit, MutableRecord } from "./codex-route-types.js";

export function recordCodexModelHit(params: {
  hits: CodexRouteHit[];
  path: string;
  model: string;
  runtime?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): string | undefined {
  if (
    isBlockedLegacyCodexModelRef({
      modelRef: params.model,
      blockedModelIdentities: params.blockedModelIdentities,
    })
  ) {
    return undefined;
  }
  const canonicalModel = toCanonicalOpenAIModelRef(params.model);
  if (!canonicalModel) {
    return undefined;
  }
  params.hits.push({
    path: params.path,
    model: params.model,
    canonicalModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  return canonicalModel;
}

export function collectStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): boolean {
  if (typeof params.value !== "string") {
    return false;
  }
  return Boolean(
    recordCodexModelHit({
      hits: params.hits,
      path: params.path,
      model: params.value.trim(),
      runtime: params.runtime,
      blockedModelIdentities: params.blockedModelIdentities,
    }),
  );
}

export function collectModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): boolean {
  if (typeof params.value === "string") {
    return collectStringModelSlot(params);
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return false;
  }
  const rewrotePrimary = collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.primary`,
    value: record.primary,
    runtime: params.runtime,
    blockedModelIdentities: params.blockedModelIdentities,
  });
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      collectStringModelSlot({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        value: entry,
        blockedModelIdentities: params.blockedModelIdentities,
      });
    }
  }
  return rewrotePrimary;
}

export function modelConfigContainsRef(value: unknown, modelRef: string): boolean {
  if (typeof value === "string") {
    return value.trim() === modelRef;
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  if (typeof record.primary === "string" && record.primary.trim() === modelRef) {
    return true;
  }
  return (
    Array.isArray(record.fallbacks) &&
    record.fallbacks.some((entry) => typeof entry === "string" && entry.trim() === modelRef)
  );
}

export function collectModelConfigRefs(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  value: unknown;
}): void {
  if (typeof params.value === "string") {
    collectStringModelConfigRef(params);
    return;
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return;
  }
  if (typeof record.primary === "string" && record.primary.trim()) {
    params.refs.push({ path: `${params.path}.primary`, modelRef: record.primary.trim() });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      if (typeof entry === "string" && entry.trim()) {
        params.refs.push({ path: `${params.path}.fallbacks.${index}`, modelRef: entry.trim() });
      }
    }
  }
}

export function collectStringModelConfigRef(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  value: unknown;
}): void {
  if (typeof params.value !== "string") {
    return;
  }
  const modelRef = params.value.trim();
  if (modelRef) {
    params.refs.push({ path: params.path, modelRef });
  }
}

export function collectCodexRuntimeModelPolicyRefs(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const [modelRef, entry] of Object.entries(record)) {
    const trimmed = modelRef.trim();
    if (!trimmed) {
      continue;
    }
    const runtime = normalizeRuntimeString(
      asMutableRecord(asMutableRecord(entry)?.agentRuntime)?.id,
    );
    if (runtime === "codex") {
      params.refs.push({ path: `${params.path}.${trimmed}`, modelRef: trimmed });
    }
  }
}

export function rewriteStringModelSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): boolean {
  if (typeof params.container?.[params.key] !== "string") {
    return false;
  }
  return rewriteModelReferenceSlot({
    ...params,
    resolve: (model, path) => recordCodexModelHit({ ...params, model, path }),
  });
}

/** Mutates model selectors; the return value reports only primary changes for runtime-policy callers. */
export function rewriteModelReferenceSlot(params: {
  container: MutableRecord | undefined;
  key: string;
  path: string;
  resolve: (model: string, path: string, role: "primary" | "fallback") => string | null | undefined;
}): boolean {
  const { container, key, path, resolve } = params;
  if (!container) {
    return false;
  }
  const value = container[key];
  if (typeof value === "string") {
    const replacement = resolve(value.trim(), path, "primary");
    if (replacement === undefined || replacement === value) {
      return false;
    }
    if (replacement === null) {
      delete container[key];
    } else {
      container[key] = replacement;
    }
    return true;
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  const primaryChanged = rewriteModelReferenceSlot({
    container: record,
    key: "primary",
    path: `${path}.primary`,
    resolve,
  });
  if (Array.isArray(record.fallbacks)) {
    record.fallbacks = record.fallbacks.flatMap((entry, index) => {
      if (typeof entry !== "string") {
        return [entry];
      }
      const replacement = resolve(entry.trim(), `${path}.fallbacks.${index}`, "fallback");
      return replacement === null ? [] : [replacement ?? entry];
    });
  }
  return primaryChanged;
}

export function rewriteModelConfigSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): boolean {
  return rewriteModelReferenceSlot({
    ...params,
    resolve: (model, path, role) =>
      recordCodexModelHit({
        ...params,
        model,
        path,
        runtime: role === "primary" ? params.runtime : undefined,
      }),
  });
}

export function rewriteModelsMap(params: {
  hits: CodexRouteHit[];
  models: MutableRecord | undefined;
  path: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  if (!params.models) {
    return;
  }
  for (const legacyRef of Object.keys(params.models)) {
    const canonicalModel = recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${legacyRef}`,
      model: legacyRef,
      blockedModelIdentities: params.blockedModelIdentities,
    });
    if (!canonicalModel) {
      continue;
    }
    const legacyEntry = params.models[legacyRef] ?? {};
    const canonicalEntry = params.models[canonicalModel];
    const legacyRecord = asMutableRecord(legacyEntry);
    const canonicalRecord = asMutableRecord(canonicalEntry);
    params.models[canonicalModel] =
      legacyRecord && canonicalRecord
        ? mergeCanonicalModelMapRecord({ legacyRecord, canonicalRecord })
        : (canonicalEntry ?? legacyEntry);
    delete params.models[legacyRef];
  }
}

function mergeCanonicalModelMapRecord(params: {
  legacyRecord: MutableRecord;
  canonicalRecord: MutableRecord;
}): MutableRecord {
  const merged = { ...params.legacyRecord, ...params.canonicalRecord };
  const legacyRuntime = asMutableRecord(params.legacyRecord.agentRuntime);
  const canonicalRuntime = asMutableRecord(params.canonicalRecord.agentRuntime);
  if (
    legacyRuntime &&
    runtimePolicyHasExplicitNonDefaultPin(legacyRuntime) &&
    !runtimePolicyHasExplicitNonDefaultPin(canonicalRuntime)
  ) {
    merged.agentRuntime = {
      ...legacyRuntime,
      ...canonicalRuntime,
      id: legacyRuntime.id,
    };
  }
  return merged;
}

function runtimePolicyHasExplicitNonDefaultPin(value: unknown): boolean {
  const id = normalizeString(asMutableRecord(value)?.id);
  return Boolean(id && id !== "auto" && id !== "default");
}
