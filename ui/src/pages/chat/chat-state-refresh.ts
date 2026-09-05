import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadChatMetadata,
  revalidateChatMetadata,
  peekChatMetadata,
  beginChatMetadataPublication,
  subscribeChatMetadata,
  type ChatMetadataResult,
} from "../../lib/chat/chat-metadata-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import {
  isUiSelectedGlobalSessionKey,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  refreshCurrentChatSessionList,
  retireChatModelSelectionOwnership,
} from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

type ChatRefreshOptions = {
  deferBranches?: boolean;
  historyLoad?: Promise<ChatHistoryResult | undefined>;
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
};

type ChatStartupMetadataHandler = (
  metadata: ChatMetadataResult | undefined,
) => void | Promise<void>;

type ChatMetadataBinding = {
  client: GatewayBrowserClient;
  scope: { agentId?: string; sessionKey: string };
  version: number;
  isCurrent: () => boolean;
  unsubscribe: () => void;
};
const metadataBindings = new WeakMap<ChatPageHost, ChatMetadataBinding>();

export function retireChatMetadataRequests(host: ChatPageHost): void {
  metadataBindings.get(host)?.unsubscribe();
  metadataBindings.delete(host);
  host.chatModelCatalog = [];
  host.chatModelCatalogError = null;
  host.chatModelsLoading = false;
  host.chatAccountSelection = null;
}

function scheduleChatMetadataRefresh(callback: () => void) {
  const requestIdleCallback =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback : null;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 750 });
    return;
  }
  globalThis.setTimeout(callback, 50);
}

export async function refreshChatCommands(host: ChatPageHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveChatAgentId(host),
    sessionKey: host.sessionKey,
  });
}

export function applySelectedChatAgent(
  host: ChatPageHost | null | undefined,
  selectedAgentId: string | null,
): void {
  if (
    !host ||
    !isUiSelectedGlobalSessionKey(host, host.sessionKey) ||
    parseAgentSessionKey(host.sessionKey)?.agentId ||
    (host.assistantAgentId ?? null) === selectedAgentId
  ) {
    return;
  }
  applyChatAgentOwnerTransition(host, selectedAgentId);
  void refreshCurrentChatSessionList(host);
}

export function applyChatAgentOwnerTransition(
  host: ChatPageHost,
  selectedAgentId: string | null,
): void {
  if ((host.assistantAgentId ?? null) === selectedAgentId) {
    return;
  }
  retireChatModelSelectionOwnership(host);
  host.assistantIdentityRequestVersion += 1;
  host.assistantAgentId = selectedAgentId;
  host.assistantName = "";
  host.assistantAvatar = null;
  host.assistantAvatarSource = null;
  host.assistantAvatarStatus = null;
  host.assistantAvatarReason = null;
  host.chatAvatarUrl = null;
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
  host.modelAuthStatusResult = null;
  host.modelAuthStatusError = null;
  // Global chats retain their session key across agent selection. Replace agent-owned
  // bindings now so their old fences reject later publications.
  void refreshChatMetadata(host);
  void refreshChatModelAuthStatus(host).finally(() => host.requestUpdate?.());
  void host.loadAssistantIdentity();
  host.requestUpdate?.();
}

function applyChatMetadataResult(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): void {
  const models = Array.isArray(result.models) ? result.models : undefined;
  host.chatAccountSelection = result.accountSelection ?? null;
  if (models) {
    host.chatModelCatalog = models;
    host.chatModelCatalogError = null;
  }
  // Missing commands keep the built-ins: commands.list uses the same server builder and fails too.
  applyRemoteSlashCommandsResult({
    client,
    agentId,
    result,
  });
}

function bindChatMetadata(host: ChatPageHost): ChatMetadataBinding | undefined {
  const previous = metadataBindings.get(host);
  if (previous?.isCurrent()) {
    return previous;
  }
  if (previous) {
    retireChatMetadataRequests(host);
  }
  const client = host.client;
  if (!client || !host.connected) {
    return undefined;
  }
  const scope = { agentId: resolveChatAgentId(host) ?? undefined, sessionKey: host.sessionKey };
  const epoch = host.connectionEpoch;
  const binding: ChatMetadataBinding = {
    client,
    scope,
    version: 0,
    isCurrent: () =>
      metadataBindings.get(host) === binding &&
      host.connected &&
      host.client === client &&
      host.connectionEpoch === epoch &&
      host.sessionKey === scope.sessionKey &&
      (resolveChatAgentId(host) ?? undefined) === scope.agentId,
    unsubscribe: subscribeChatMetadata(client, scope, (update) => {
      if (!binding.isCurrent()) {
        return;
      }
      if (update.type === "invalidated") {
        void refreshChatMetadata(host);
        return;
      }
      if (update.type === "loading") {
        binding.version += 1;
        host.chatModelsLoading = host.chatModelCatalog.length === 0;
        host.chatModelCatalogError = null;
      } else {
        host.chatModelsLoading = false;
        if (update.type === "result") {
          applyChatMetadataResult(host, client, scope.agentId, update.result);
        } else {
          host.chatModelCatalogError = formatUiError(update.error);
        }
      }
      host.requestUpdate?.();
    }),
  };
  metadataBindings.set(host, binding);
  const cached = peekChatMetadata(client, scope);
  if (cached) {
    applyChatMetadataResult(host, client, scope.agentId, cached);
  }
  return binding;
}

export async function refreshChatMetadata(host: ChatPageHost): Promise<void> {
  const binding = bindChatMetadata(host);
  if (!binding) {
    retireChatMetadataRequests(host);
    return;
  }
  // Only accepted store publications update availability or fetch errors.
  await loadChatMetadata(binding.client, binding.scope).catch(() => undefined);
}

export async function refreshChatModelAuthStatus(host: ChatPageHost, opts?: { refresh?: boolean }) {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const agentId = resolveChatAgentId(host);
  const requestVersion = ++host.modelAuthStatusRequestVersion;
  const ownsRequest = () =>
    host.client === client &&
    host.connected &&
    host.connectionEpoch === connectionEpoch &&
    host.modelAuthStatusRequestVersion === requestVersion &&
    resolveChatAgentId(host) === agentId;
  try {
    const result = await loadModelAuthStatus(client, {
      ...opts,
      agentId,
    });
    if (!ownsRequest()) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = result.unavailable?.message ?? null;
  } catch (err) {
    if (!ownsRequest()) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = formatUiError(err);
  }
}

export async function refreshChatModelCatalogOnDemand(host: ChatPageHost): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  const binding = bindChatMetadata(host);
  if (!binding) {
    return;
  }
  const {
    client,
    scope: { agentId },
  } = binding;
  const version = binding.version;
  const ownsRequest = () => binding.isCurrent() && binding.version === version;
  host.chatModelsLoading = host.chatModelCatalog.length === 0;
  host.chatModelCatalogError = null;
  host.requestUpdate?.();
  try {
    await loadModelCatalog(client, {
      agentId: agentId ?? "",
      refreshIfDue: true,
    });
    if (binding.isCurrent()) {
      await refreshChatMetadata(host);
      // Full model discovery can complete after the session projection used at mount time.
      // Refresh through the normal session owner so thinking/context metadata converges without
      // letting the UI guess which provider- or runtime-specific levels are valid.
      await refreshCurrentChatSessionList(host).catch(() => undefined);
    }
  } catch (error) {
    if (ownsRequest()) {
      // Keep the startup/prepared snapshot usable while recording the failed
      // discovery. Reopening the picker starts another uncached load.
      host.chatModelCatalogError = formatUiError(error);
    }
  } finally {
    if (ownsRequest()) {
      host.chatModelsLoading = false;
      host.requestUpdate?.();
    }
  }
}

async function refreshChat(
  host: ChatPageHost,
  opts?: ChatRefreshOptions & {
    onStartupMetadata?: ChatStartupMetadataHandler;
  },
) {
  const refreshedClient = host.client;
  const refreshedEpoch = host.connectionEpoch;
  const refreshedSessionKey = host.sessionKey;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad =
    opts?.historyLoad ??
    loadChatHistory(host, {
      deferBranches: opts?.deferBranches === true,
      startup: opts?.startup === true,
    });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (!history?.sessionInfo) {
      return;
    }
    const admitted = host.sessions.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessions.state.agentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      sourceCanonicalListRevision: history.sourceCanonicalListRevision,
      // The routed chat remains visible after archive even though the active
      // roster excludes it. Keep its descriptor in shared session state until
      // navigation changes; otherwise the pane briefly falls back to the raw
      // key while the sidebar lineage reload catches up.
      archivedFilter: history.sessionInfo.archived === true ? "all" : host.sessionsArchivedFilter,
    });
    if (
      !admitted ||
      host.client !== refreshedClient ||
      host.connectionEpoch !== refreshedEpoch ||
      host.sessionKey !== refreshedSessionKey ||
      resolveAgentIdForSession(host) !== refreshedAgentId
    ) {
      return;
    }
    // The shared roster may belong to another agent. Keep this pane's accepted
    // global history separate rather than relabeling or borrowing that roster.
    const scopedHistory =
      isUiSelectedGlobalSessionKey(host, refreshedSessionKey) &&
      host.sessions.state.agentId !== refreshedAgentId;
    host.sessionsResult = scopedHistory
      ? reconcileSessionHistory(
          host.sessionsResultAgentId === refreshedAgentId ? host.sessionsResult : null,
          history.sessionInfo,
          history.defaults,
          {
            resultAgentId: refreshedAgentId,
            selectedGlobalAgentId: refreshedAgentId,
            archivedFilter: "all",
          },
          // Only this pane's changed projection proves a newer same-agent row;
          // a later Main list cannot freeze Work history or block a missing row.
          host.sessionsResultAgentId === refreshedAgentId &&
            host.sessionsResult !== previousSessionsResult,
        )
      : host.sessions.state.result;
    host.sessionsResultAgentId = scopedHistory ? refreshedAgentId : host.sessions.state.agentId;
    const sessionInfo = selectedChatSessionRow(host);
    const rosterRow = sessionInfo ?? history.sessionInfo;
    if (sessionInfo) {
      host.selectedChatSessionArchived = rosterRow.archived === true;
      host.selectedChatSessionIncognito = rosterRow.incognito === true;
    }
    const snapshotRunId = history.inFlightRun?.runId?.trim();
    const activeRunIds = history.sessionInfo.activeRunIds;
    const snapshotConfirmsCurrentRun = Boolean(
      snapshotRunId &&
      host.chatRunId === snapshotRunId &&
      isSessionRunActive(history.sessionInfo) &&
      (!Array.isArray(activeRunIds) || activeRunIds.includes(snapshotRunId)),
    );
    if (snapshotConfirmsCurrentRun) {
      // History just adopted this authoritative active run. A newer catalog
      // timestamp may still describe its prior terminal state during remount.
      return;
    }
    if (!sessionInfo) {
      return;
    }
    const runReconciled = reconcileChatRunFromSessionRow(host, sessionInfo, {
      publishRunStatus: true,
    });
    if (!runReconciled) {
      reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: true });
    }
  });
  const startupMetadataRefresh =
    opts?.startup === true && opts.onStartupMetadata
      ? historyLoad.then(
          (history) => opts.onStartupMetadata?.(history?.metadata),
          () => opts.onStartupMetadata?.(undefined),
        )
      : Promise.resolve();
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
    () => void flushChatQueueForEvent(host),
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh, startupMetadataRefresh]).finally(
    requestUpdate,
  );
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
}

export function refreshPageChat(host: ChatPageHost, opts?: ChatRefreshOptions) {
  const binding = opts?.startup ? bindChatMetadata(host) : undefined;
  const publication = binding
    ? beginChatMetadataPublication(binding.client, binding.scope)
    : undefined;
  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: async (metadata) => {
      // The publication belongs to the shared scope, not the pane that started history.
      // Final subscriber release or invalidation retires it; one pane closing must not.
      if (!binding || !publication?.isCurrent()) {
        return;
      }
      if (metadata) {
        publication.publish(metadata);
      } else {
        // Startup can omit its bounded projection. Read the same session scope without history.
        await revalidateChatMetadata(binding.client, binding.scope).catch(() => undefined);
      }
    },
  });
  const sessionKey = host.sessionKey;
  const client = host.client;
  const epoch = host.connectionEpoch;
  scheduleChatMetadataRefresh(() => {
    if (
      !host.connected ||
      host.client !== client ||
      host.connectionEpoch !== epoch ||
      host.sessionKey !== sessionKey
    ) {
      return;
    }
    void Promise.allSettled([
      refreshChatAvatar(host),
      ...(!opts?.startup ? [refreshChatMetadata(host)] : []),
    ]).finally(() => host.requestUpdate?.());
  });
  return refresh;
}
