import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeStoredOverrideModel } from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
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
} from "./session-utils-core.js";

export function buildSessionListRowMetadataContext(params: {
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
}): SessionListRowContext {
  return {
    subagentRuns: buildSubagentSessionListReadIndex(params.now),
    selectedModelByOverrideRef: new Map(),
    thinkingMetadataByModelRef: new Map(),
    displayModelIdentityByKey: new Map(),
    modelCostConfigByModelRef: new Map(),
    userProfileIdentityById: params.userProfileIdentityById ?? new Map(),
    acpSessionMetaByEntry: new Map(),
  };
}

export function buildSingleRowStoreChildSessionsByKey(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  key: string;
  now: number;
}): Map<string, string[]> {
  return buildStoreChildSessionIndex({
    store: params.store,
    keys: [params.key],
    now: params.now,
    candidates: getSingleRowChildSessionCandidates({
      storePath: params.storePath,
      store: params.store,
    }),
    requireCurrentController: true,
  });
}

export function resolveSessionSelectedModelRef(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
  rowContext?: SessionListRowContext;
  allowPluginNormalization?: boolean;
}): ReturnType<typeof resolveSessionModelRef> {
  const override = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  if (!params.rowContext) {
    return resolveSessionModelRef(params.cfg, params.entry, params.agentId, {
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
  const key = [
    normalizeAgentId(params.agentId),
    override.providerOverride ?? "",
    override.modelOverride ?? "",
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
  const storeChildSessions = buildStoreChildSessionIndex({
    store,
    keys: [controllerSessionKey],
    now,
    subagentRuns,
  }).get(controllerSessionKey);
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
