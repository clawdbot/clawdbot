import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaBatch } from "../acp/runtime/session-meta.js";
import { readSessionRuntimeOwnership } from "../agents/harness/session-runtime-ownership.js";
import { normalizeStoredOverrideModel } from "../agents/model-selection.js";
import {
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
} from "../agents/session-model-ref.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionEntryPair } from "./session-list-order.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import { readRecentSessionUsageFromTranscript as readScopedRecentSessionUsageFromTranscript } from "./session-transcript-readers.js";
import type {
  SessionActorProfileIdentity,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  buildStoreChildSessionIndex,
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
  key: string;
  now: number;
}): Map<string, string[]> {
  return buildStoreChildSessionIndex({
    store: params.store,
    keys: [params.key],
    now: params.now,
    requireCurrentController: true,
  });
}

export function resolveSessionSelectedModelRef(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
  sessionKey?: string;
  rowContext?: SessionListRowContext;
  allowPluginNormalization?: boolean;
}): ReturnType<typeof resolveSessionModelRef> {
  // Ownership is session-specific; never reuse the ordinary override cache for native tuples.
  const ownership = readSessionRuntimeOwnership({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
  if (ownership?.modelRef) {
    return ownership.modelRef;
  }
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
  freshTotalTokens?: number;
  fallbackModelRef?: string;
  allowPluginNormalization?: boolean;
  maxTranscriptBytes?: number;
  rowContext?: SessionListRowContext;
  agentId: string;
}): {
  estimatedCostUsd?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
} | null {
  const { entry, agentId } = params;
  if (!entry?.sessionId) {
    return null;
  }
  const resolvedModel = resolveSessionModelIdentityRef(
    params.cfg,
    entry,
    agentId,
    params.fallbackModelRef,
    { allowPluginNormalization: params.allowPluginNormalization },
  );
  if (
    params.freshTotalTokens !== undefined &&
    resolveEstimatedSessionCostUsd({
      cfg: params.cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      entry,
      rowContext: params.rowContext,
    }) !== undefined
  ) {
    return null;
  }
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
  const estimatedCostUsd = resolveEstimatedSessionCostUsd({
    cfg: params.cfg,
    provider: snapshot.modelProvider ?? resolvedModel.provider,
    model: snapshot.model ?? resolvedModel.model,
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
    totalTokens: resolvePositiveNumber(snapshot.totalTokens),
    totalTokensFresh: snapshot.totalTokensFresh === true,
    estimatedCostUsd,
  };
}

export function populateSessionListAcpMetadata(params: {
  cfg: OpenClawConfig;
  entries: readonly SessionEntryPair[];
  opts: SessionsListParams;
  rowContext?: SessionListRowContext;
}): void {
  const metadataByEntry = params.rowContext?.acpSessionMetaByEntry;
  if (!metadataByEntry || params.entries.length === 0) {
    return;
  }
  const entries = params.entries
    .filter(([, entry]) => !metadataByEntry.has(entry))
    .map(([key, entry]) => {
      const parsed = parseAgentSessionKey(key);
      const agentId = normalizeAgentId(
        parsed?.agentId ?? params.opts.agentId ?? resolveSessionStoreAgentId(params.cfg, key),
      );
      return {
        sessionKey: resolveStoredSessionKeyForAgentStore({
          cfg: params.cfg,
          agentId,
          sessionKey: key,
        }),
        agentId,
        entry,
      };
    });
  if (!entries.length) {
    return;
  }
  const metadata = readAcpSessionMetaBatch({
    entries,
    cfg: params.cfg,
  });
  // Record absent metadata too, so selected rows do not repeat missing-store reads.
  for (const { entry } of entries) {
    metadataByEntry.set(entry, metadata.get(entry));
  }
}
