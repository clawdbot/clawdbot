import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { getSessionDisplaySubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  buildGroupDisplayName,
  type InternalSessionEntry,
  type SessionEntry,
} from "../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunActive } from "../shared/session-run-state.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  projectGatewaySessionRunState,
  projectGatewaySessionActiveRun,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import {
  resolveSessionDisplayModelIdentityRefCached,
  resolveGatewaySessionRuntimeProjection,
} from "./session-utils-model.js";
import {
  buildSingleRowStoreChildSessionsByKey,
  buildSessionListRowMetadataContext,
  populateSessionListAcpMetadata,
  resolveSessionSelectedModelRef,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import {
  isGroupOrChannelDisplaySession,
  loadGatewaySessionEntryReadOnly,
  parseGroupKey,
} from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}

function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string },
) {
  const provider = normalizeOptionalString(identity.provider);
  const model = normalizeOptionalString(identity.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

function matchesSessionListSearch(fields: Array<string | undefined>, search: string): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

function shouldResolveDerivedSessionModelSearchFields(search: string): boolean {
  // Preserve key-query semantics: derived model aliases are not agent-key matches.
  return !search.startsWith("agent:");
}

export function resolveSessionListRowContext(params: {
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
}): SessionListRowContext | undefined {
  return params.rowContext ?? params.getRowContext?.();
}

function resolveSessionListSearchModelFields(params: {
  agentId: string;
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  rowContext?: SessionListRowContext;
  selectedModel?: ReturnType<typeof resolveSessionSelectedModelRef>;
}): Array<string | undefined> {
  const { agentId } = params;
  const subagentRun = params.rowContext
    ? params.rowContext.subagentRuns.getDisplaySubagentRun(params.key)
    : getSessionDisplaySubagentRunByChildSessionKey(params.key);
  const selectedModel =
    params.selectedModel ??
    resolveSessionSelectedModelRef({
      cfg: params.cfg,
      sessionKey: params.key,
      entry: params.entry,
      agentId,
      rowContext: params.rowContext,
      allowPluginNormalization: false,
    });
  const resolvedModel = resolveSessionModelIdentityRef(
    params.cfg,
    params.entry,
    agentId,
    subagentRun?.model,
    { allowPluginNormalization: false },
  );
  const displayModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg: params.cfg,
    provider: selectedModel.provider,
    model: selectedModel.model,
    rowContext: params.rowContext,
  });
  const fields: Array<string | undefined> = [];
  addSessionListSearchModelFields(fields, {
    provider: params.entry?.modelProvider,
    model: params.entry?.model,
  });
  addSessionListSearchModelFields(fields, resolvedModel);
  addSessionListSearchModelFields(fields, selectedModel);
  addSessionListSearchModelFields(fields, displayModelIdentity);
  return fields;
}

export function createSessionListSearchMatcher(params: {
  cfg: OpenClawConfig;
  search: string;
  targetsBySessionKey: GatewayStoredSessionTargets;
  now: number;
  visibleEntries: readonly SessionEntryPair[];
  getRowContext?: SessionListRowContextProvider;
  projectActiveRun?: SessionListActiveRunProjector;
}) {
  const { cfg, search, now } = params;
  const identityNames = new Map<string, string>();
  let rowContext: SessionListRowContext | undefined;
  const context = () =>
    (rowContext ??= params.getRowContext?.() ?? buildSessionListRowMetadataContext({ now }));
  let acpPrepared = false;
  return (key: string, entry: SessionEntry): boolean => {
    const fields = [
      key,
      entry.label,
      entry.subject,
      entry.sessionId,
      entry.category,
      resolveSessionListSearchDisplayName(key, entry),
      resolveGatewaySessionDisplayName(key, entry),
      resolveGatewaySessionKind(key, entry),
    ];
    addSessionListSearchModelFields(fields, { provider: entry.modelProvider, model: entry.model });
    if (matchesSessionListSearch(fields, search)) {
      return true;
    }
    const agentId = expectDefined(params.targetsBySessionKey.get(key), "search row owner").agentId;
    const run = projectGatewaySessionRunState({ key, entry, now, rowContext: context() }).fields;
    const active = params.projectActiveRun?.(key, entry, agentId);
    const state = projectGatewaySessionActiveRun(active, run.status);
    const goal = resolveGatewaySessionGoal(entry, now);
    if (
      matchesSessionListSearch(
        [
          state.status,
          isSessionRunActive(state)
            ? "live running"
            : state.hasActiveRun === false
              ? "idle"
              : undefined,
          goal
            ? `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`
            : undefined,
        ],
        search,
      )
    ) {
      return true;
    }
    if (!identityNames.has(agentId)) {
      identityNames.set(agentId, resolveAssistantIdentity({ cfg, agentId }).name);
    }
    if (matchesSessionListSearch([identityNames.get(agentId)], search)) {
      return true;
    }
    const selected = resolveSessionSelectedModelRef({
      cfg,
      sessionKey: key,
      entry,
      agentId,
      rowContext: context(),
      allowPluginNormalization: false,
    });
    if (
      shouldResolveDerivedSessionModelSearchFields(search) &&
      matchesSessionListSearch(
        resolveSessionListSearchModelFields({
          cfg,
          key,
          entry,
          agentId,
          rowContext: context(),
          selectedModel: selected,
        }),
        search,
      )
    ) {
      return true;
    }
    if (!acpPrepared) {
      populateSessionListAcpMetadata({
        cfg,
        entries: params.visibleEntries,
        targetsBySessionKey: params.targetsBySessionKey,
        rowContext: context(),
      });
      acpPrepared = true;
    }
    const { agentRuntime } = resolveGatewaySessionRuntimeProjection({
      cfg,
      sessionKey: key,
      entry,
      agentId,
      provider: selected.provider,
      model: selected.model,
      rowContext: context(),
    });
    return matchesSessionListSearch([formatAgentRuntimeLabel(agentRuntime)], search);
  };
}

type LoadGatewaySessionRowOptions = {
  agentId?: string;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  now?: number;
  transcriptUsageMaxBytes?: number;
  includeSwarmSummary?: boolean;
};

function loadGatewaySessionSnapshot(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
  lightweight = false,
): { lifecycleRunId?: string; row: GatewaySessionRow | null } {
  const now = options?.now ?? Date.now();
  const { cfg, agentId, storePath, store, entry, canonicalKey } = loadGatewaySessionEntryReadOnly(
    sessionKey,
    {
      clone: false,
      includeStoreChildEntries: true,
      agentId: options?.agentId,
    },
  );
  if (!entry) {
    return { row: null };
  }
  const rowContext = options?.includeSwarmSummary
    ? buildSessionListRowMetadataContext({ now })
    : undefined;
  const storeChildSessionsByKey = buildSingleRowStoreChildSessionsByKey({
    store,
    key: canonicalKey,
    now,
    subagentRuns: rowContext?.subagentRuns,
  });
  const lifecycleRunId = (entry as InternalSessionEntry).lifecycleRunId;
  return {
    ...(lifecycleRunId === undefined ? {} : { lifecycleRunId }),
    row: buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key: canonicalKey,
      entry,
      now,
      includeDerivedTitles: options?.includeDerivedTitles,
      includeLastMessage: options?.includeLastMessage,
      transcriptUsageMaxBytes: options?.transcriptUsageMaxBytes,
      storeChildSessionsByKey,
      skipTranscriptUsageFallback: lightweight,
      lightweightListRow: lightweight,
      agentId,
      // Event snapshots carry complete counts, while ordinary exact-row reads stay scoped.
      rowContext,
    }),
  };
}

export function loadGatewaySessionLifecycleSnapshot(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
): { lifecycleRunId?: string; row: GatewaySessionRow | null } {
  return loadGatewaySessionSnapshot(sessionKey, options, true);
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: LoadGatewaySessionRowOptions,
): GatewaySessionRow | null {
  return loadGatewaySessionSnapshot(sessionKey, options).row;
}

export function buildGatewaySessionInfo(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  agentId: string;
  now?: number;
  modelCatalog?: ModelCatalogEntry[];
}): GatewaySessionRow {
  const now = params.now ?? Date.now();
  const storeChildSessionsByKey = buildSingleRowStoreChildSessionsByKey({
    store: params.store,
    key: params.key,
    now,
  });
  return buildGatewaySessionRow({
    cfg: params.cfg,
    storePath: params.storePath,
    store: params.store,
    key: params.key,
    entry: params.entry,
    agentId: params.agentId,
    modelCatalog: params.modelCatalog,
    now,
    storeChildSessionsByKey,
    skipTranscriptUsageFallback: true,
    lightweightListRow: true,
  });
}
