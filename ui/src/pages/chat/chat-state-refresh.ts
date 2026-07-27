import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import { loadChatHistory, type ChatMetadataResult, type ChatState } from "./chat-history.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import { flushChatQueueAfterIdleSessionReconciliation } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { applyModelCatalogResult, loadModels } from "./models.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

type ChatMetadataApplyResult = {
  commands: boolean;
  models: boolean;
};

type ChatRefreshOptions = {
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
): ChatMetadataApplyResult {
  const models = applyModelCatalogResult(result.models);
  if (models) {
    host.chatModelCatalog = models;
  }
  const commandsApplied = applyRemoteSlashCommandsResult({
    client,
    agentId,
    result,
  });
  return { commands: commandsApplied, models: Boolean(models) };
}

function ownsChatMetadataRequest(request: ChatMetadataRequest): boolean {
  return (
    request.host.client === request.client &&
    request.host.connected &&
    request.host.chatMetadataRequestVersion === request.version &&
    resolveChatAgentId(request.host) === request.agentId
  );
}

async function refreshCompatibilityModelCatalog(request: ChatMetadataRequest) {
  const models = await loadModels(request.client);
  if (ownsChatMetadataRequest(request)) {
    request.host.chatModelCatalog = models;
  }
}

async function refreshCompatibilityCommands(request: ChatMetadataRequest) {
  await refreshSlashCommands({
    client: request.client,
    agentId: request.agentId,
    shouldApply: () => ownsChatMetadataRequest(request),
  });
}

function canUseCompatibilityModelCatalog(
  host: ChatPageHost,
  agentId: string | null | undefined,
): boolean {
  return agentId === resolveUiDefaultAgentId(host);
}

export async function refreshChatMetadata(
  host: ChatPageHost,
  opts?: { preserveModelCatalogOnFallback?: boolean },
) {
  const requestVersion = ++host.chatMetadataRequestVersion;
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  const client = host.client;
  const agentId = resolveChatAgentId(host);
  const request = { host, client, agentId, version: requestVersion };
  const shouldRefreshCompatibilityModels =
    !opts?.preserveModelCatalogOnFallback && canUseCompatibilityModelCatalog(host, agentId);
  const shouldClearUnresolvedModels =
    !opts?.preserveModelCatalogOnFallback && !shouldRefreshCompatibilityModels;
  host.chatModelsLoading = true;
  try {
    if (isGatewayMethodAdvertised(host as unknown as ChatState, "chat.metadata") === false) {
      if (shouldClearUnresolvedModels) {
        host.chatModelCatalog = [];
      }
      await Promise.allSettled([
        ...(shouldRefreshCompatibilityModels ? [refreshCompatibilityModelCatalog(request)] : []),
        refreshCompatibilityCommands(request),
      ]);
      return;
    }

    const result = await client.request<ChatMetadataResult>(
      "chat.metadata",
      agentId ? { agentId } : {},
    );
    if (!ownsChatMetadataRequest(request)) {
      return;
    }
    const metadataApplied = applyChatMetadataResult(host, client, agentId, result);
    if (!metadataApplied.models && shouldClearUnresolvedModels) {
      host.chatModelCatalog = [];
    }
    if (!metadataApplied.models || !metadataApplied.commands) {
      await Promise.allSettled([
        ...(!metadataApplied.models && shouldRefreshCompatibilityModels
          ? [refreshCompatibilityModelCatalog(request)]
          : []),
        ...(metadataApplied.commands ? [] : [refreshCompatibilityCommands(request)]),
      ]);
    }
  } catch {
    if (ownsChatMetadataRequest(request)) {
      if (shouldClearUnresolvedModels) {
        host.chatModelCatalog = [];
      }
      await Promise.allSettled([
        ...(shouldRefreshCompatibilityModels ? [refreshCompatibilityModelCatalog(request)] : []),
        refreshCompatibilityCommands(request),
      ]);
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
  try {
    const result = await loadModelAuthStatus(client, opts);
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = null;
  } catch (err) {
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = err instanceof Error ? err.message : String(err);
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
  const historyLoad = loadChatHistory(host as unknown as ChatState, {
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
    }
    const reconciled = host.sessions.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessionsResultAgentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      archivedFilter: host.sessionsArchivedFilter,
    });
    const sessionsResult = reconciled ? host.sessions.state.result : host.sessionsResult;
    if (reconciled) {
      host.sessionsResult = sessionsResult;
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
  let resolveStartupMetadata: (result: ChatMetadataApplyResult) => void = () => {};
  const ownsStartupMetadata = Boolean(opts?.startup && host.client && host.connected);
  const startupMetadataRequestVersion = ownsStartupMetadata
    ? ++host.chatMetadataRequestVersion
    : null;
  const startupMetadataApplied = ownsStartupMetadata
    ? new Promise<ChatMetadataApplyResult>((resolve) => {
        resolveStartupMetadata = resolve;
      })
    : Promise.resolve({ commands: false, models: false });

  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: ({ client, agentId, metadata }) => {
      const ownsMetadata =
        startupMetadataRequestVersion !== null &&
        host.chatMetadataRequestVersion === startupMetadataRequestVersion &&
        host.client === client &&
        host.connected &&
        resolveChatAgentId(host) === agentId;
      const applied =
        metadata && ownsMetadata
          ? applyChatMetadataResult(host, client, agentId, metadata)
          : { commands: false, models: false };
      resolveStartupMetadata(applied);
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
    void startupMetadataApplied
      .catch(() => ({ commands: false, models: false }))
      .then(async (metadataApplied) => {
        // Startup metadata can settle after a session switch. Recheck ownership
        // so stale startup work cannot supersede the new pane's catalog refresh.
        if (!ownsScheduledMetadataRefresh()) {
          return;
        }
        await Promise.allSettled([
          refreshChatAvatar(host),
          refreshChatMetadata(host, {
            preserveModelCatalogOnFallback: opts?.startup === true && metadataApplied.models,
          }),
        ]);
      })
      .finally(() => host.requestUpdate?.());
  });
  return refresh;
}
