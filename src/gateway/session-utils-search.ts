import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { getSessionDisplaySubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";
import { buildGroupDisplayName, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import type {
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import { resolveSessionDisplayModelIdentityRefCached } from "./session-utils-model.js";
import {
  buildSingleRowStoreChildSessionsByKey,
  resolveSessionSelectedModelRef,
} from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";
import {
  isGroupOrChannelDisplaySession,
  loadSessionEntryReadOnly,
  parseGroupKey,
} from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export function resolveSessionListSearchDisplayName(
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

export function matchesSessionListSearch(
  fields: Array<string | undefined>,
  search: string,
): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

export function appendStoredSessionModelSearchFields(
  fields: Array<string | undefined>,
  entry?: SessionEntry,
) {
  const provider = normalizeOptionalString(entry?.modelProvider);
  const model = normalizeOptionalString(entry?.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

export function shouldResolveDerivedSessionModelSearchFields(search: string): boolean {
  // Agent session-key searches are already covered by cheap key fields; do not
  // hydrate model metadata for every non-matching row on hot TUI lookups.
  return !search.startsWith("agent:");
}

export function resolveSessionListRowContext(params: {
  rowContext?: SessionListRowContext;
  getRowContext?: SessionListRowContextProvider;
}): SessionListRowContext | undefined {
  return params.rowContext ?? params.getRowContext?.();
}

export function resolveSessionListSearchModelFields(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  rowContext?: SessionListRowContext;
}): Array<string | undefined> {
  const parsedAgent = parseAgentSessionKey(params.key);
  const agentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(params.cfg));
  const subagentRun = params.rowContext
    ? params.rowContext.subagentRuns.getDisplaySubagentRun(params.key)
    : getSessionDisplaySubagentRunByChildSessionKey(params.key);
  const selectedModel = resolveSessionSelectedModelRef({
    cfg: params.cfg,
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
  const modelIdentity = {
    provider: resolvedModel.provider,
    model: resolvedModel.model ?? DEFAULT_MODEL,
  };
  const selectedOrRuntimeModelProvider = selectedModel?.provider ?? modelIdentity.provider;
  const selectedOrRuntimeModel = selectedModel?.model ?? modelIdentity.model;
  const displayModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg: params.cfg,
    agentId,
    provider: selectedOrRuntimeModelProvider,
    model: selectedOrRuntimeModel,
    rowContext: params.rowContext,
  });
  const fields: Array<string | undefined> = [];
  addSessionListSearchModelFields(fields, {
    provider: params.entry?.modelProvider,
    model: params.entry?.model,
  });
  addSessionListSearchModelFields(fields, resolvedModel);
  if (selectedModel) {
    addSessionListSearchModelFields(fields, selectedModel);
  }
  addSessionListSearchModelFields(fields, displayModelIdentity);
  return fields;
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: {
    agentId?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
    now?: number;
    transcriptUsageMaxBytes?: number;
  },
): GatewaySessionRow | null {
  const now = options?.now ?? Date.now();
  const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntryReadOnly(sessionKey, {
    clone: false,
    ...(options?.agentId ? { agentId: options.agentId } : {}),
  });
  if (!entry) {
    return null;
  }
  const storeChildSessionsByKey = buildSingleRowStoreChildSessionsByKey({
    storePath,
    store,
    key: canonicalKey,
    now,
  });
  return buildGatewaySessionRow({
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
    ...(options?.agentId ? { agentId: options.agentId } : {}),
  });
}

export function buildGatewaySessionInfo(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  agentId?: string;
  now?: number;
  modelCatalog?: ModelCatalogEntry[];
}): GatewaySessionRow {
  const now = params.now ?? Date.now();
  const storeChildSessionsByKey = buildSingleRowStoreChildSessionsByKey({
    storePath: params.storePath,
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
