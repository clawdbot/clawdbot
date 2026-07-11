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
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import type { SessionCapability } from "../sessions/index.ts";
import {
  buildToolsEffectiveRequestKey,
  loadToolsEffective as loadToolsEffectiveShared,
  refreshVisibleToolsEffectiveForCurrentSession,
  resetToolsEffectiveState,
} from "./tools-effective.ts";

export type AgentsPanel =
  | "overview"
  | "files"
  | "tools"
  | "skills"
  | "channels"
  | "cron"
  | "memory";

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

export type AgentsConfigCapability = {
  readonly state: { configFormDirty: boolean };
  save: () => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
};

type AgentGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

type AgentGateway = {
  readonly snapshot: AgentGatewaySnapshot;
  subscribe: (listener: (snapshot: AgentGatewaySnapshot) => void) => () => void;
};

type AgentFilesStatus = {
  list: AgentsFilesListResult | null;
  loading: boolean;
  error: string | null;
};

type AgentCapabilityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
};

export type AgentCapability = {
  readonly state: AgentCapabilityState;
  adoptList: (result: AgentsListResult, client: GatewayBrowserClient) => void;
  ensureList: () => Promise<AgentsListResult | null>;
  refreshList: () => Promise<AgentsListResult | null>;
  files: (agentId: string | null | undefined) => AgentFilesStatus;
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

function hasSelectedAgentMismatch(state: AgentsState, agentId: string): boolean {
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

export async function loadAgents(state: AgentsState) {
  const client = state.client;
  if (!client || !state.connected || state.agentsLoading) {
    return;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await loadAgentsList(client);
    if (!isCurrent()) {
      return;
    }
    state.agentsList = res;
    const selected = state.agentsSelectedId;
    if (!selected || !res.agents.some((entry) => entry.id === selected)) {
      state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.agentsList = null;
      state.agentsError = formatMissingOperatorReadScopeMessage("agent list");
    } else {
      state.agentsError = String(err);
    }
  } finally {
    if (isCurrent()) {
      state.agentsLoading = false;
    }
  }
}

export async function loadToolsCatalog(state: AgentsState, agentId: string) {
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
  state: AgentsState,
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
): Promise<void> {
  const hadPendingConfigDraft = config.state.configFormDirty;
  if (config.stageDefaultAgent(agentId)) {
    if (!hadPendingConfigDraft && config.state.configFormDirty) {
      const saved = await config.save();
      if (saved) {
        await refreshAgents();
      }
    }
  }
}

function emptyAgentFilesStatus(): AgentFilesStatus {
  return { list: null, loading: false, error: null };
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const normalized = agentId?.trim();
  return normalized ? normalized : null;
}

export function createAgentCapability(gateway: AgentGateway): AgentCapability {
  const state: AgentCapabilityState = {
    client: gateway.snapshot.client,
    connected: gateway.snapshot.connected,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
  };
  const files = new Map<string, AgentFilesStatus>();
  const fileRequests = new Map<string, Promise<AgentsFilesListResult | null>>();
  const fileRequestOwners = new Map<string, symbol>();
  const listeners = new Set<(state: AgentCapabilityState) => void>();
  let disposed = false;
  // Transport reconnects reuse the client object, so identity alone cannot
  // stop pre-disconnect completions from repopulating capability state.
  let requestGeneration = 0;
  let agentsRequest: Promise<AgentsListResult | null> | null = null;
  let agentsRequestOwner: symbol | null = null;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const isCurrentRequest = (client: GatewayBrowserClient, generation: number) =>
    !disposed && state.connected && state.client === client && requestGeneration === generation;

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
    const client = state.client;
    if (!client || !state.connected) {
      return state.agentsList;
    }
    if (agentsRequest && !force) {
      return agentsRequest;
    }
    state.agentsLoading = true;
    state.agentsError = null;
    publish();
    const generation = requestGeneration;
    const owner = Symbol();
    agentsRequestOwner = owner;
    const request = loadAgentsList(client)
      .then((result) => {
        const current = isCurrentRequest(client, generation) && agentsRequestOwner === owner;
        if (current) {
          state.agentsList = result;
          state.agentsError = null;
        }
        return current ? result : null;
      })
      .catch((err: unknown) => {
        if (isCurrentRequest(client, generation) && agentsRequestOwner === owner) {
          state.agentsError = isMissingOperatorReadScopeError(err)
            ? formatMissingOperatorReadScopeMessage("agent list")
            : String(err);
        }
        return null;
      })
      .finally(() => {
        const currentRequest = agentsRequestOwner === owner;
        if (currentRequest) {
          agentsRequest = null;
          agentsRequestOwner = null;
        }
        if (currentRequest && isCurrentRequest(client, generation)) {
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
    const agentId = normalizeAgentId(rawAgentId);
    const client = state.client;
    if (!agentId || !client || !state.connected) {
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
    const generation = requestGeneration;
    const owner = Symbol();
    fileRequestOwners.set(agentId, owner);
    const request = loadAgentFilesList(client, agentId)
      .then((result) => {
        const current =
          isCurrentRequest(client, generation) && fileRequestOwners.get(agentId) === owner;
        if (current && result) {
          status.list = result;
          status.error = null;
        }
        return current ? status.list : null;
      })
      .catch((err: unknown) => {
        if (isCurrentRequest(client, generation) && fileRequestOwners.get(agentId) === owner) {
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
        if (currentRequest && isCurrentRequest(client, generation)) {
          status.loading = false;
          publish();
        }
      });
    fileRequests.set(agentId, request);
    return request;
  };

  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    if (clientChanged || !snapshot.connected) {
      requestGeneration += 1;
      agentsRequest = null;
      agentsRequestOwner = null;
      fileRequests.clear();
      fileRequestOwners.clear();
    }
    if (clientChanged || !snapshot.connected) {
      files.clear();
      state.agentsList = null;
      state.agentsError = null;
    }
    if (clientChanged || !snapshot.connected) {
      state.agentsLoading = false;
      for (const status of files.values()) {
        status.loading = false;
      }
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    adoptList(result, client) {
      if (state.client !== client || !state.connected) {
        return;
      }
      state.agentsList = result;
      state.agentsError = null;
      publish();
    },
    ensureList: () => loadList(false),
    refreshList: () => loadList(true),
    files(agentId) {
      const normalized = normalizeAgentId(agentId);
      return normalized
        ? (files.get(normalized) ?? emptyAgentFilesStatus())
        : emptyAgentFilesStatus();
    },
    ensureFiles: (agentId) => loadFiles(agentId, false),
    refreshFiles: (agentId) => loadFiles(agentId, true),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      requestGeneration += 1;
      stopGateway();
      listeners.clear();
      fileRequests.clear();
      fileRequestOwners.clear();
      files.clear();
      agentsRequest = null;
      agentsRequestOwner = null;
      state.agentsLoading = false;
    },
  };
}
