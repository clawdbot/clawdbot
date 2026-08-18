import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  loadChatMetadata,
  peekChatMetadata,
  rememberChatMetadata,
  type ChatMetadataResult,
} from "../../lib/chat/chat-metadata-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import { loadChatHistory } from "./chat-history.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import { flushChatQueueAfterIdleSessionReconciliation } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { loadModels } from "./models.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

type ChatRefreshOptions = {
  deferBranches?: boolean;
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
};

type ChatStartupMetadataHandler = (params: {
  client: GatewayBrowserClient;
  agentId: string | null | undefined;
  metadata: ChatMetadataResult | undefined;
}) => void | Promise<void>;

type ChatMetadataRequest = {
  host: ChatPageHost;
  client: GatewayBrowserClient;
  agentId: string | null | undefined;
  version: number;
};

type ChatMetadataRefreshOptions = {
  requestVersion?: number;
};

export function retireChatMetadataRequests(
  host: Pick<ChatPageHost, "chatMetadataRequestVersion">,
): void {
  host.chatMetadataRequestVersion += 1;
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
  });
}

function applyChatMetadataResult(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): void {
  const models = Array.isArray(result.models) ? result.models : undefined;
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

function seedChatModelCatalogFromStore(host: ChatPageHost, client: GatewayBrowserClient): void {
  const cached = peekChatMetadata(client, resolveChatAgentId(host));
  if (!Array.isArray(cached?.models)) {
    return;
  }
  // A warm snapshot turns mount-time loading into refreshing; the in-flight
  // request still owns the authoritative apply.
  host.chatModelCatalog = cached.models;
  host.chatModelCatalogError = null;
}

function ownsChatMetadataRequest(request: ChatMetadataRequest): boolean {
  return (
    request.host.client === request.client &&
    request.host.connected &&
    request.host.chatMetadataRequestVersion === request.version &&
    resolveChatAgentId(request.host) === request.agentId
  );
}

export async function refreshChatMetadata(
  host: ChatPageHost,
  opts?: ChatMetadataRefreshOptions,
): Promise<void> {
  const requestVersion = opts?.requestVersion ?? ++host.chatMetadataRequestVersion;
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    host.chatModelCatalogError = null;
    return;
  }
  if (host.chatMetadataRequestVersion !== requestVersion) {
    return;
  }
  const client = host.client;
  const agentId = resolveChatAgentId(host);
  const request = { host, client, agentId, version: requestVersion };
  host.chatModelsLoading = true;
  seedChatModelCatalogFromStore(host, client);
  try {
    const result = await loadChatMetadata(client, agentId);
    if (!ownsChatMetadataRequest(request)) {
      return;
    }
    applyChatMetadataResult(host, client, agentId, result);
  } catch (error) {
    if (ownsChatMetadataRequest(request)) {
      host.chatModelCatalogError = formatUiError(error);
    }
  } finally {
    if (ownsChatMetadataRequest(request)) {
      host.chatModelsLoading = false;
    }
  }
}

export async function refreshChatModelAuthStatus(host: ChatPageHost, opts?: { refresh?: boolean }) {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  try {
    const result = await loadModelAuthStatus(client, {
      ...opts,
      agentId: resolveChatAgentId(host),
    });
    if (host.client !== client || !host.connected || host.connectionEpoch !== connectionEpoch) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = null;
  } catch (err) {
    if (host.client !== client || !host.connected || host.connectionEpoch !== connectionEpoch) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = formatUiError(err);
  }
}

export async function refreshChatModelCatalogOnDemand(
  host: ChatPageHost,
  opts?: { refresh?: boolean },
): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  const agentId = resolveChatAgentId(host);
  const connectionEpoch = host.connectionEpoch;
  const ownsRequest = () =>
    host.client === client &&
    host.connected &&
    host.connectionEpoch === connectionEpoch &&
    resolveChatAgentId(host) === agentId;
  host.chatModelsLoading = true;
  host.chatModelCatalogError = null;
  host.requestUpdate?.();
  try {
    const models = await loadModels(client, {
      agentId,
      ...(opts?.refresh ? { refresh: true } : {}),
      rejectOnFailure: true,
    });
    if (ownsRequest()) {
      host.chatModelCatalog = models;
      host.chatModelCatalogError = null;
    }
  } catch (error) {
    if (ownsRequest()) {
      // Keep the startup/prepared snapshot usable while making the failed
      // discovery and its retry path visible in the open picker.
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
  const refreshedSessionKey = host.sessionKey;
  const refreshedClient = host.client;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad = loadChatHistory(host, {
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
    if (areUiSessionKeysEquivalent(history.sessionInfo.key, refreshedSessionKey)) {
      host.selectedChatSessionArchived = history.sessionInfo.archived === true;
      host.selectedChatSessionIncognito = history.sessionInfo.incognito === true;
    }
    const reconciled = host.sessions.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessionsResultAgentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      // The routed chat remains visible after archive even though the active
      // roster excludes it. Keep its descriptor in shared session state until
      // navigation changes; otherwise the pane briefly falls back to the raw
      // key while the sidebar lineage reload catches up.
      archivedFilter: history.sessionInfo.archived === true ? "all" : host.sessionsArchivedFilter,
    });
    const sessionsResult = reconciled ? host.sessions.state.result : host.sessionsResult;
    if (reconciled) {
      host.sessionsResult = sessionsResult;
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
    const sessionInfo = sessionsResult?.sessions.find(
      (row: GatewaySessionRow) =>
        areUiSessionKeysEquivalent(row.key, history.sessionInfo?.key) ||
        row.key === refreshedSessionKey,
    );
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
    opts?.startup === true && opts.onStartupMetadata && refreshedClient
      ? historyLoad.then((history) => {
          if (
            host.client !== refreshedClient ||
            !host.connected ||
            host.sessionKey !== refreshedSessionKey ||
            resolveAgentIdForSession(host) !== refreshedAgentId
          ) {
            return;
          }
          return opts.onStartupMetadata?.({
            client: refreshedClient,
            agentId: refreshedAgentId,
            metadata: history?.metadata,
          });
        })
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
  const ownsStartupMetadata = Boolean(opts?.startup && host.client && host.connected);
  const startupMetadataRequestVersion = ownsStartupMetadata
    ? ++host.chatMetadataRequestVersion
    : null;
  if (ownsStartupMetadata && host.client) {
    host.chatModelsLoading = true;
    seedChatModelCatalogFromStore(host, host.client);
  }

  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: async ({ client, agentId, metadata }) => {
      if (
        startupMetadataRequestVersion === null ||
        host.chatMetadataRequestVersion !== startupMetadataRequestVersion ||
        host.client !== client ||
        !host.connected ||
        resolveChatAgentId(host) !== agentId
      ) {
        return;
      }
      const request: ChatMetadataRequest = {
        host,
        client,
        agentId,
        version: startupMetadataRequestVersion,
      };
      try {
        if (!metadata) {
          // Missing startup metadata means the bounded catalog projection could not finish.
          // Start the scoped combined fallback now, on the response signal, rather than at idle.
          await refreshChatMetadata(host, { requestVersion: startupMetadataRequestVersion });
          return;
        }
        rememberChatMetadata(client, agentId, metadata);
        applyChatMetadataResult(host, client, agentId, metadata);
      } finally {
        if (ownsChatMetadataRequest(request)) {
          host.chatModelsLoading = false;
        }
      }
    },
  });

  const refreshedSessionKey = host.sessionKey;
  const ownsScheduledMetadataRefresh = () =>
    host.sessionKey === refreshedSessionKey &&
    host.connected &&
    (startupMetadataRequestVersion === null ||
      host.chatMetadataRequestVersion === startupMetadataRequestVersion);
  scheduleChatMetadataRefresh(() => {
    if (!ownsScheduledMetadataRefresh()) {
      return;
    }
    void Promise.allSettled([
      refreshChatAvatar(host),
      ...(startupMetadataRequestVersion === null ? [refreshChatMetadata(host)] : []),
    ]).finally(() => host.requestUpdate?.());
  });
  return refresh;
}
