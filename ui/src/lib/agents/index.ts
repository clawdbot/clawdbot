import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  SessionsListResult,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionSnapshot,
} from "../gateway-connection-lifecycle.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import type { SessionCapability } from "../sessions/index.ts";
import type { AgentsPanel } from "./panels.ts";
import {
  buildToolsEffectiveRequestKey,
  loadToolsEffective as loadToolsEffectiveShared,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
} from "./tools-effective.ts";

export type { AgentsPanel } from "./panels.ts";
export { watchAgentScope } from "./watch-agent-scope.ts";

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  sessions: Pick<SessionCapability, "state">;
  toolsCatalogLoading: boolean;
  toolsCatalogLoadingAgentId?: string | null;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey?: string | null;
  toolsEffectiveResultKey?: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  sessionKey?: string;
  sessionsResult?: SessionsListResult | null;
  chatModelCatalog?: ModelCatalogEntry[];
  agentsPanel?: AgentsPanel;
};

type AgentToolsState = Omit<AgentsState, "agentsLoading" | "agentsError">;

type AgentsConfigCapability = {
  readonly state: { configFormDirty: boolean };
  save: (options?: { canDispatch?: () => boolean }) => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
};

type AgentGateway = {
  readonly snapshot: GatewayConnectionSnapshot;
  subscribe: (listener: (snapshot: GatewayConnectionSnapshot) => void) => () => void;
};

type AgentFilesStatus = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
};

type AgentCapabilityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  listRevision: number;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
};

export type AgentCapability = {
  readonly state: AgentCapabilityState;
  adoptList: (
    result: AgentsListResult,
    client: GatewayBrowserClient,
    expectedRevision?: number,
  ) => boolean;
  ensureList: () => Promise<AgentsListResult | null>;
  refreshList: () => Promise<AgentsListResult | null>;
  files: (agentId: string | null | undefined) => AgentFilesStatus;
  invalidateFiles: (agentIds: readonly (string | null | undefined)[]) => void;
  ensureFiles: (agentId: string) => Promise<AgentsFilesListResult | null>;
  refreshFiles: (agentId: string) => Promise<AgentsFilesListResult | null>;
  subscribe: (listener: (state: AgentCapabilityState) => void) => () => void;
  dispose: () => void;
};

async function loadAgentsList(client: GatewayBrowserClient): Promise<AgentsListResult> {
  return client.request<AgentsListResult>("agents.list", {});
}

async function loadAgentFilesList(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<AgentsFilesListResult | null> {
  return client.request<AgentsFilesListResult | null>("agents.files.list", { agentId });
}

function hasSelectedAgentMismatch(state: AgentToolsState, agentId: string): boolean {
  return Boolean(state.agentsSelectedId && state.agentsSelectedId !== agentId);
}

function resolveToolsErrorMessage(
  err: unknown,
  target: "tools catalog" | "effective tools",
): string {
  return isMissingOperatorReadScopeError(err)
    ? formatMissingOperatorReadScopeMessage(target)
    : String(err);
}

export async function loadToolsCatalog(state: AgentToolsState, agentId: string) {
  const resolvedAgentId = agentId.trim();
  const client = state.client;
  if (
    !client ||
    !state.connected ||
    !resolvedAgentId ||
    (state.toolsCatalogLoading && state.toolsCatalogLoadingAgentId === resolvedAgentId)
  ) {
    return;
  }
  const generation = state.requestGeneration;
  const shouldIgnoreResponse = () =>
    state.client !== client ||
    state.requestGeneration !== generation ||
    state.toolsCatalogLoadingAgentId !== resolvedAgentId ||
    hasSelectedAgentMismatch(state, resolvedAgentId);
  state.toolsCatalogLoading = true;
  state.toolsCatalogLoadingAgentId = resolvedAgentId;
  state.toolsCatalogError = null;
  state.toolsCatalogResult = null;
  try {
    const res = await client.request<ToolsCatalogResult>("tools.catalog", {
      agentId: resolvedAgentId,
      includePlugins: true,
    });
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsCatalogResult = res;
  } catch (err) {
    if (shouldIgnoreResponse()) {
      return;
    }
    state.toolsCatalogError = resolveToolsErrorMessage(err, "tools catalog");
  } finally {
    if (
      state.client === client &&
      state.requestGeneration === generation &&
      state.toolsCatalogLoadingAgentId === resolvedAgentId
    ) {
      state.toolsCatalogLoadingAgentId = null;
      state.toolsCatalogLoading = false;
    }
  }
}

export {
  buildToolsEffectiveRequestKey,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
};

export async function loadToolsEffective(
  state: AgentToolsState,
  params: { agentId: string; sessionKey: string },
) {
  const client = state.client;
  const generation = state.requestGeneration;
  await loadToolsEffectiveShared(state, params, {
    isCurrent: () =>
      state.client === client && state.connected && state.requestGeneration === generation,
    ignoreResponse: (agentId, requestKey) =>
      state.toolsEffectiveLoadingKey !== requestKey || hasSelectedAgentMismatch(state, agentId),
    onError: (err) => resolveToolsErrorMessage(err, "effective tools"),
  });
}

export async function setDefaultAgent(
  config: AgentsConfigCapability,
  agentId: string,
  refreshAgents: () => Promise<unknown>,
  canDispatch: () => boolean = () => true,
): Promise<void> {
  if (!canDispatch()) {
    return;
  }
  const hadPendingConfigDraft = config.state.configFormDirty;
  if (config.stageDefaultAgent(agentId)) {
    if (!hadPendingConfigDraft && config.state.configFormDirty) {
      const saved = await config.save({ canDispatch });
      if (saved && canDispatch()) {
        await refreshAgents();
      }
    }
  }
}

type AgentIdentityUpdate = {
  agentId: string;
  name?: string;
  emoji?: string;
  avatar?: string;
};

/** Persist identity fields through the gateway; the handler also rewrites the
    agent's workspace IDENTITY.md so agent and UI share one identity source. */
export async function updateAgentIdentity(
  client: GatewayBrowserClient,
  update: AgentIdentityUpdate,
): Promise<void> {
  await client.request("agents.update", {
    agentId: update.agentId,
    ...(update.name ? { name: update.name } : {}),
    ...(update.emoji ? { emoji: update.emoji } : {}),
    ...(update.avatar ? { avatar: update.avatar } : {}),
  });
}

function emptyAgentFilesStatus(): AgentFilesStatus {
  return { list: null, loading: false, error: null };
}

function readOptionalAgentId(agentId: string | null | undefined): string | null {
  const normalized = agentId?.trim();
  return normalized ? normalized : null;
}

export function createAgentCapability(gateway: AgentGateway): AgentCapability {
  const lifecycle = createGatewayConnectionLifecycle(gateway.snapshot);
  const state: AgentCapabilityState = {
    client: gateway.snapshot.client,
    connected: gateway.snapshot.phase === "connected",
    listRevision: 0,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
  };
  const files = new Map<string, AgentFilesStatus>();
  const fileRequests = new Map<string, Promise<AgentsFilesListResult | null>>();
  const fileRequestOwners = new Map<string, symbol>();
  const listeners = new Set<(state: AgentCapabilityState) => void>();
  let disposed = false;
  let agentsRequest: Promise<AgentsListResult | null> | null = null;

  const retireAgentsRequest = () => {
    agentsRequest = null;
    state.listRevision += 1;
    state.agentsLoading = false;
  };

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const fileStatus = (agentId: string): AgentFilesStatus => {
    const existing = files.get(agentId);
    if (existing) {
      return existing;
    }
    const next = emptyAgentFilesStatus();
    files.set(agentId, next);
    return next;
  };

  const loadList = async (force: boolean): Promise<AgentsListResult | null> => {
    const scope = lifecycle.capture();
    if (!scope) {
      return state.agentsList;
    }
    if (agentsRequest && !force) {
      return agentsRequest;
    }
    const revision = ++state.listRevision;
    state.agentsLoading = true;
    state.agentsError = null;
    publish();
    const request = loadAgentsList(scope.client)
      .then((result) => {
        const current = lifecycle.isCurrent(scope) && state.listRevision === revision;
        if (current) {
          state.agentsList = result;
          state.agentsError = null;
        }
        return current ? result : null;
      })
      .catch((err: unknown) => {
        if (lifecycle.isCurrent(scope) && state.listRevision === revision) {
          state.agentsError = isMissingOperatorReadScopeError(err)
            ? formatMissingOperatorReadScopeMessage("agent list")
            : String(err);
        }
        return null;
      })
      .finally(() => {
        const currentRequest = state.listRevision === revision;
        if (currentRequest) {
          agentsRequest = null;
        }
        if (currentRequest && lifecycle.isCurrent(scope)) {
          state.agentsLoading = false;
          publish();
        }
      });
    agentsRequest = request;
    return request;
  };

  const loadFiles = async (
    rawAgentId: string,
    force: boolean,
  ): Promise<AgentsFilesListResult | null> => {
    const agentId = readOptionalAgentId(rawAgentId);
    const scope = lifecycle.capture();
    if (!agentId || !scope) {
      return agentId ? (files.get(agentId)?.list ?? null) : null;
    }
    const status = fileStatus(agentId);
    if (status.list && !force) {
      return status.list;
    }
    const activeRequest = fileRequests.get(agentId);
    if (activeRequest && !force) {
      return activeRequest;
    }
    status.loading = true;
    status.error = null;
    publish();
    const owner = Symbol();
    fileRequestOwners.set(agentId, owner);
    const request = loadAgentFilesList(scope.client, agentId)
      .then((result) => {
        const current = lifecycle.isCurrent(scope) && fileRequestOwners.get(agentId) === owner;
        if (current && result) {
          status.list = result;
          status.error = null;
        }
        return current ? status.list : null;
      })
      .catch((err: unknown) => {
        if (lifecycle.isCurrent(scope) && fileRequestOwners.get(agentId) === owner) {
          status.error = String(err);
        }
        return null;
      })
      .finally(() => {
        const currentRequest = fileRequestOwners.get(agentId) === owner;
        if (currentRequest) {
          fileRequests.delete(agentId);
          fileRequestOwners.delete(agentId);
        }
        if (currentRequest && lifecycle.isCurrent(scope)) {
          status.loading = false;
          publish();
        }
      });
    fileRequests.set(agentId, request);
    return request;
  };

  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connected = snapshot.phase === "connected";
    lifecycle.transition(snapshot);
    state.client = snapshot.client;
    state.connected = connected;
    if (clientChanged || !connected) {
      retireAgentsRequest();
      fileRequests.clear();
      fileRequestOwners.clear();
      for (const status of files.values()) {
        status.loading = false;
      }
      files.clear();
      state.agentsList = null;
      state.agentsError = null;
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    adoptList(result, client, expectedRevision = state.listRevision) {
      if (state.client !== client || !state.connected || state.listRevision !== expectedRevision) {
        return false;
      }
      // Startup adoption retires older direct loads so late completions cannot overwrite it.
      retireAgentsRequest();
      state.agentsList = result;
      state.agentsError = null;
      publish();
      return true;
    },
    ensureList: () => loadList(false),
    refreshList: () => loadList(true),
    files(agentId) {
      const normalized = readOptionalAgentId(agentId);
      return normalized
        ? (files.get(normalized) ?? emptyAgentFilesStatus())
        : emptyAgentFilesStatus();
    },
    invalidateFiles(agentIds) {
      let changed = false;
      const normalizedIds = new Set(
        agentIds.map(readOptionalAgentId).filter((agentId): agentId is string => agentId !== null),
      );
      for (const agentId of normalizedIds) {
        changed = files.delete(agentId) || changed;
        changed = fileRequests.delete(agentId) || changed;
        changed = fileRequestOwners.delete(agentId) || changed;
      }
      if (changed) {
        publish();
      }
    },
    ensureFiles: (agentId) => loadFiles(agentId, false),
    refreshFiles: (agentId) => loadFiles(agentId, true),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      lifecycle.dispose();
      stopGateway();
      listeners.clear();
      fileRequests.clear();
      fileRequestOwners.clear();
      files.clear();
      retireAgentsRequest();
    },
  };
}
