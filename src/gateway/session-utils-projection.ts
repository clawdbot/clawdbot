import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { normalizeStoredOverrideModel } from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { buildSubagentRunReadIndex } from "../agents/subagent-registry-read.js";
import { resolveStorePath, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readRecentSessionUsageFromTranscript as readScopedRecentSessionUsageFromTranscript } from "./session-transcript-readers.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import {
  buildStoreChildSessionIndex,
  getSingleRowChildSessionCandidates,
  resolveEstimatedSessionCostUsd,
  resolvePositiveNumber,
  resolveRuntimeChildSessionKeys,
  resolveStoreChildSessionKeysFromCandidates,
} from "./session-utils-core.js";
import { resolveConcreteSessionStorePath } from "./session-utils-store.js";

export function buildSessionListRowContext(params: {
  store: Record<string, SessionEntry>;
  now: number;
}): SessionListRowContext {
  const subagentRuns = buildSubagentRunReadIndex(params.now);
  return buildSessionListRowContextFromParts({
    subagentRuns,
    storeChildSessionsByKey: buildStoreChildSessionIndex(params.store, params.now, subagentRuns),
  });
}

function buildSessionListRowContextFromParts(params: {
  subagentRuns: ReturnType<typeof buildSubagentRunReadIndex>;
  storeChildSessionsByKey: Map<string, string[]>;
}): SessionListRowContext {
  return {
    subagentRuns: params.subagentRuns,
    storeChildSessionsByKey: params.storeChildSessionsByKey,
    selectedModelByOverrideRef: new Map(),
    thinkingMetadataByModelRef: new Map(),
    displayModelIdentityByKey: new Map(),
    modelCostConfigByModelRef: new Map(),
    userProfileLabelById: new Map(),
  };
}

export function buildSessionListRowMetadataContext(params: { now: number }): SessionListRowContext {
  return buildSessionListRowContextFromParts({
    subagentRuns: buildSubagentRunReadIndex(params.now),
    storeChildSessionsByKey: new Map(),
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

export function resolveSessionSelectedModelRef(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
  rowContext?: SessionListRowContext;
  allowPluginNormalization?: boolean;
}): ReturnType<typeof resolveSessionModelRef> | null {
  const override = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  if (!override.modelOverride) {
    return null;
  }
  if (!params.rowContext) {
    return resolveSessionModelRef(params.cfg, params.entry, params.agentId, {
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
  const key = [
    normalizeAgentId(params.agentId),
    override.providerOverride ?? "",
    override.modelOverride,
  ].join("\0");
  const cached = params.rowContext.selectedModelByOverrideRef.get(key);
  if (cached) {
    return cached;
  }
  const selected = resolveSessionModelRef(params.cfg, params.entry, params.agentId, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  params.rowContext.selectedModelByOverrideRef.set(key, selected);
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
  contextTokens?: number;
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
    : normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
  const storePath =
    resolveConcreteSessionStorePath(params.storePath) ??
    resolveStorePath(params.cfg.session?.store, { agentId });
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
  const contextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    // Gateway/session listing is read-only; don't start async model discovery.
    allowAsyncLoad: false,
  });
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
    contextTokens: resolvePositiveNumber(contextTokens),
    estimatedCostUsd,
  };
}
