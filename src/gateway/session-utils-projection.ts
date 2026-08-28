import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeStoredOverrideModel } from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveStoredModelOverride } from "../sessions/stored-model-overrides.js";
import { resolveSessionStoreAgentId } from "./session-store-key.js";
import { readRecentSessionUsageFromTranscript as readScopedRecentSessionUsageFromTranscript } from "./session-transcript-readers.js";
import type {
  SessionActorProfileIdentity,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  buildStoreChildSessionIndex,
  getSingleRowChildSessionCandidates,
  resolveEstimatedSessionCostUsd,
  resolvePositiveNumber,
  resolveRuntimeChildSessionKeys,
  resolveStoreChildSessionKeysFromCandidates,
} from "./session-utils-core.js";

export function buildSessionListRowContext(params: {
  store: Record<string, SessionEntry>;
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  const subagentRuns = buildSubagentSessionListReadIndex(params.now);
  return buildSessionListRowContextFromParts({
    subagentRuns,
    storeChildSessionsByKey: buildStoreChildSessionIndex(params.store, params.now, subagentRuns),
    userProfileIdentityById: params.userProfileIdentityById,
  });
}

function buildSessionListRowContextFromParts(params: {
  subagentRuns: SessionListRowContext["subagentRuns"];
  storeChildSessionsByKey: Map<string, string[]>;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  return {
    subagentRuns: params.subagentRuns,
    storeChildSessionsByKey: params.storeChildSessionsByKey,
    selectedModelByOverrideRef: new Map(),
    thinkingMetadataByModelRef: new Map(),
    displayModelIdentityByKey: new Map(),
    modelCostConfigByModelRef: new Map(),
    userProfileIdentityById: params.userProfileIdentityById ?? new Map(),
    acpSessionMetaByEntry: new Map(),
  };
}

export function buildSessionListRowMetadataContext(params: {
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  return buildSessionListRowContextFromParts({
    subagentRuns: buildSubagentSessionListReadIndex(params.now),
    storeChildSessionsByKey: new Map(),
    userProfileIdentityById: params.userProfileIdentityById,
  });
}

export function buildSingleRowStoreChildSessionsByKey(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  key: string;
  now: number;
}): Map<string, string[]> {
  const storeChildSessions = resolveStoreChildSessionKeysFromCandidates({
    store: params.store,
    key: params.key,
    now: params.now,
    candidates: getSingleRowChildSessionCandidates({
      storePath: params.storePath,
      store: params.store,
    }),
  });
  return storeChildSessions ? new Map([[params.key, storeChildSessions]]) : new Map();
}

export function resolveSessionSelectedModel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  rowContext?: SessionListRowContext;
  allowPluginNormalization?: boolean;
}): ReturnType<typeof resolveSessionModelRef> & {
  source: "default" | "session" | "parent";
} {
  const configuredDefault = resolveSessionModelRef(params.cfg, undefined, params.agentId, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  const storedOverride = resolveStoredModelOverride({
    sessionEntry: params.entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.entry?.parentSessionKey,
    defaultProvider: configuredDefault.provider,
  });
  const source = storedOverride?.source ?? "default";
  const selectedEntry = storedOverride
    ? {
        providerOverride: storedOverride.provider,
        modelOverride: storedOverride.model,
        ...(storedOverride.routeResolution === "resolved"
          ? { modelOverrideRouteResolution: "resolved" as const }
          : {}),
      }
    : undefined;
  const override = normalizeStoredOverrideModel({
    providerOverride: selectedEntry?.providerOverride,
    modelOverride: selectedEntry?.modelOverride,
  });
  const key = [
    normalizeAgentId(params.agentId),
    source,
    override.providerOverride ?? "",
    override.modelOverride ?? "",
  ].join("\0");
  const cached = params.rowContext?.selectedModelByOverrideRef.get(key);
  if (cached) {
    return { ...cached, source };
  }
  const selected = resolveSessionModelRef(params.cfg, selectedEntry, params.agentId, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  params.rowContext?.selectedModelByOverrideRef.set(key, selected);
  return { ...selected, source };
}

export function resolveSessionSelectedModelRef(
  params: Parameters<typeof resolveSessionSelectedModel>[0],
): ReturnType<typeof resolveSessionModelRef> {
  const { source: _source, ...selected } = resolveSessionSelectedModel(params);
  return selected;
}

export function mergeChildSessionKeys(
  runtimeChildSessions: string[] | undefined,
  storeChildSessions: string[] | undefined,
): string[] | undefined {
  if (!runtimeChildSessions?.length) {
    return storeChildSessions?.length ? storeChildSessions : undefined;
  }
  if (!storeChildSessions?.length) {
    return runtimeChildSessions;
  }
  return uniqueStrings([...runtimeChildSessions, ...storeChildSessions]);
}

export function resolveChildSessionKeys(
  controllerSessionKey: string,
  store: Record<string, SessionEntry>,
  now = Date.now(),
  subagentRuns?: SessionListRowContext["subagentRuns"],
): string[] | undefined {
  const runtimeChildSessions = resolveRuntimeChildSessionKeys(
    controllerSessionKey,
    now,
    subagentRuns,
  );
  const storeChildSessions = buildStoreChildSessionIndex(store, now, subagentRuns).get(
    controllerSessionKey,
  );
  return mergeChildSessionKeys(runtimeChildSessions, storeChildSessions);
}

export function resolveTranscriptUsageFallback(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  maxTranscriptBytes?: number;
  rowContext?: SessionListRowContext;
  agentId?: string;
}): {
  estimatedCostUsd?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  modelProvider?: string;
  model?: string;
} | null {
  const entry = params.entry;
  if (!entry?.sessionId) {
    return null;
  }
  const parsed = parseAgentSessionKey(params.key);
  const agentId = parsed?.agentId
    ? normalizeAgentId(parsed.agentId)
    : normalizeAgentId(params.agentId ?? resolveSessionStoreAgentId(params.cfg, params.key));
  const storePath =
    resolveConcreteSessionStorePath(params.storePath) ??
    resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  let snapshot: ReturnType<typeof readScopedRecentSessionUsageFromTranscript>;
  try {
    snapshot = readScopedRecentSessionUsageFromTranscript(
      {
        agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: params.key,
        storePath,
      },
      typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : 256 * 1024,
    );
  } catch {
    return null;
  }
  if (!snapshot) {
    return null;
  }
  const modelProvider = snapshot.modelProvider ?? params.fallbackProvider;
  const model = snapshot.model ?? params.fallbackModel;
  const estimatedCostUsd = resolveEstimatedSessionCostUsd({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    explicitCostUsd: snapshot.costUsd,
    entry: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheRead: snapshot.cacheRead,
      cacheWrite: snapshot.cacheWrite,
    },
    rowContext: params.rowContext,
  });
  return {
    modelProvider,
    model,
    totalTokens: resolvePositiveNumber(snapshot.totalTokens),
    totalTokensFresh: snapshot.totalTokensFresh === true,
    estimatedCostUsd,
  };
}
