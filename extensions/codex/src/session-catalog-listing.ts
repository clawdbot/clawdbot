import { listAgentIds, resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThreadTurnsListResponse } from "./app-server/protocol.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { listAdoptedSessionEntries } from "./session-catalog-adoption.js";
import type { CodexCatalogHome } from "./session-catalog-homes.js";
import { listNodeAdoptedSessionEntries } from "./session-catalog-node-adoption.js";
import {
  compareNodeLabels,
  listPairedNode,
  nodeLabel,
  type CatalogNode,
} from "./session-catalog-node-continue.js";
import {
  catalogError,
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_CAPABILITY,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  filterCatalogPageByTitle,
  MAX_CURSOR_LENGTH,
  MAX_HOST_COUNT,
  MAX_SESSION_ID_LENGTH,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  NODE_INVOKE_TIMEOUT_MS,
  parseCatalogPage,
  parseJsonParams,
  parseTranscriptPage,
  readBoundedOptionalString,
  readGatewayParams,
  readPageParams,
  requireOnlyKeys,
  unwrapNodeInvokePayload,
} from "./session-catalog-parsing.js";
import {
  codexNodeTerminalCapability,
  createCodexTerminalNodeHostCommand,
  requireCatalogEligibleThread,
  type CodexTerminalConfigSources,
} from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogHost,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionTranscriptPage,
} from "./session-catalog-types.js";

async function listGatewayHost(params: {
  agentId: string;
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  control: CodexSessionCatalogControl;
  query: CodexSessionCatalogParams;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
  source?: CodexCatalogHome;
}): Promise<CodexSessionCatalogHost> {
  const hostId = params.source?.hostId ?? CODEX_LOCAL_SESSION_HOST_ID;
  const label = params.source?.label ?? "Local Codex";
  const sourceHomeId = params.source?.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID;
  try {
    const page = parseCatalogPage(
      await params.control.listPage({
        limit: params.query.limitPerHost,
        ...(params.query.cursors?.[hostId] ? { cursor: params.query.cursors[hostId] } : {}),
        ...(params.query.search ? { searchTerm: params.query.search } : {}),
      }),
    );
    const adoptedSessions = await listAdoptedSessionEntries({
      agentId: params.agentId,
      bindingStore: params.bindingStore,
      config: params.config,
      runtime: params.runtime,
      sessionEntries: params.sessionEntries,
    });
    return {
      hostId,
      label,
      kind: "gateway",
      connected: true,
      ...page,
      sessions: page.sessions.map((session) => {
        const adopted =
          adoptedSessions.get(sessionCatalogAdoptedSourceKey(sourceHomeId, session.threadId)) ??
          (hostId === CODEX_LOCAL_SESSION_HOST_ID
            ? adoptedSessions.get(
                sessionCatalogAdoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, session.threadId),
              )
            : undefined);
        const sourced = params.source
          ? Object.assign({}, session, { sourceHomeId: params.source.sourceHomeId })
          : session;
        return adopted ? Object.assign({}, sourced, { sessionKey: adopted.key }) : sourced;
      }),
    };
  } catch (error) {
    return {
      hostId,
      label,
      kind: "gateway",
      connected: false,
      sessions: [],
      error: catalogError("APP_SERVER_UNAVAILABLE", error),
    };
  }
}

/** Lists Gateway-local and paired-node Codex sessions with per-host failures. */
export async function listCodexSessionCatalog(params: {
  agentId?: string;
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControlFactory;
  query?: CodexSessionCatalogParams;
  listNodes?: Parameters<SessionCatalogProvider["list"]>[0]["listNodes"];
  onHost?: (host: CodexSessionCatalogHost) => void;
  sessionEntries?: SessionCatalogEntrySnapshot;
  includeLocal?: boolean;
  localHomes?: CodexCatalogHome[];
}): Promise<CodexSessionCatalogResult> {
  const agentId = resolveSessionAgentIds({
    config: params.config ?? {},
    agentId: params.agentId,
  }).sessionAgentId;
  const query = readGatewayParams(params.query);
  const requestedHostIds = query.hostIds ? new Set(query.hostIds) : undefined;
  const configuredLocalHomes = params.localHomes?.filter(
    (source) => !requestedHostIds || requestedHostIds.has(source.hostId),
  );
  const localSources =
    configuredLocalHomes ??
    (params.includeLocal !== false &&
    (!requestedHostIds || requestedHostIds.has(CODEX_LOCAL_SESSION_HOST_ID))
      ? [undefined]
      : []);
  const localHosts = localSources.map((source) =>
    listGatewayHost({
      agentId,
      bindingStore: params.bindingStore,
      config: params.config,
      control: params.control.forRequest(agentId, source),
      query,
      runtime: params.runtime,
      sessionEntries: params.sessionEntries,
      ...(source ? { source } : {}),
    }),
  );
  for (const host of localHosts) {
    if (params.onHost) {
      void host.then(params.onHost).catch(() => undefined);
    }
  }
  const wantsNodes =
    !requestedHostIds || query.hostIds?.some((hostId) => hostId.startsWith("node:"));
  if (!wantsNodes) {
    return { hosts: await Promise.all(localHosts) };
  }
  let nodes: CatalogNode[];
  try {
    nodes = (await (params.listNodes?.() ?? params.runtime.nodes.list())).nodes
      .filter(
        (node) =>
          node.gatewayLocal !== true &&
          node.commands?.includes(CODEX_APP_SERVER_THREADS_LIST_COMMAND) &&
          (!requestedHostIds || requestedHostIds.has(`node:${node.nodeId}`)),
      )
      .slice(0, MAX_HOST_COUNT - localHosts.length);
  } catch (error) {
    const registryHost: CodexSessionCatalogHost = {
      hostId: "node:registry",
      label: "Paired nodes",
      kind: "node",
      connected: false,
      sessions: [],
      error: catalogError("NODE_LIST_FAILED", error),
    };
    params.onHost?.(registryHost);
    return {
      hosts: [...(await Promise.all(localHosts)), registryHost],
    };
  }
  const adoptedNodeSessions = listNodeAdoptedSessionEntries({
    agentId,
    config: params.config,
    runtime: params.runtime,
    sessionEntries: params.sessionEntries,
  });
  const nodeHosts = nodes.toSorted(compareNodeLabels).map(async (node) => {
    const host = await listPairedNode({
      agentId,
      runtime: params.runtime,
      node,
      query,
      adoptedSessions: adoptedNodeSessions,
      ...(params.onHost ? { onHost: params.onHost } : {}),
    });
    return Object.assign(host, codexNodeTerminalCapability(node));
  });
  return { hosts: await Promise.all([...localHosts, ...nodeHosts]) };
}

/** Builds the node-local read-only Codex app-server catalog command. */
export function createCodexSessionCatalogNodeHostCommands(
  controlFactory: CodexSessionCatalogControlFactory,
  configSources: CodexTerminalConfigSources,
): OpenClawPluginNodeHostCommand[] {
  // Node commands register before an agent request exists. Bind from the invoke payload so
  // explicit multi-agent Codex homes never collapse to an ambient default.
  const bindRequest = (paramsJSON?: string | null) => {
    const parsed = parseJsonParams(paramsJSON);
    if (!isRecord(parsed)) {
      throw new CatalogParamsError("Codex session catalog parameters must be an object");
    }
    const requestedAgentId = readBoundedOptionalString(parsed, "agentId", MAX_SESSION_ID_LENGTH);
    const config = configSources.getRuntimeConfig() ?? {};
    const agentId = resolveSessionAgentIds({ config, agentId: requestedAgentId }).sessionAgentId;
    if (!listAgentIds(config).includes(agentId)) {
      throw new CatalogParamsError(`unknown Codex session catalog agent: ${agentId}`);
    }
    const request = { ...parsed };
    delete request.agentId;
    return {
      agentId,
      control: controlFactory.forRequest(agentId),
      params: request,
      paramsJSON: JSON.stringify(request),
    };
  };
  return [
    {
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const request = bindRequest(paramsJSON);
        const pageParams = readPageParams(request.params);
        try {
          const page = filterCatalogPageByTitle(
            parseCatalogPage(await request.control.listPage(pageParams)),
            pageParams.searchTerm,
          );
          return JSON.stringify(page);
        } catch {
          // App-server stderr and transport details stay on the node boundary.
          throw new Error("Codex app-server catalog is unavailable");
        }
      },
    },
    {
      command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const request = bindRequest(paramsJSON);
        const action = readNodeTranscriptParams(request.params);
        try {
          await requireCatalogEligibleThread(request.control, action.threadId);
          const page = parseTranscriptPage(
            await request.control.listTurnPage({
              threadId: action.threadId,
              limit: action.limit,
              sortDirection: "desc",
              itemsView: "full",
              ...(action.cursor ? { cursor: action.cursor } : {}),
            }),
          );
          return JSON.stringify(page);
        } catch (error) {
          if (error instanceof CatalogParamsError) {
            throw error;
          }
          throw new Error("Codex app-server transcript is unavailable", { cause: error });
        }
      },
    },
    createCodexTerminalNodeHostCommand(bindRequest, configSources),
  ];
}

type CodexNodeSessionTranscriptParams = {
  threadId: string;
  cursor?: string;
  limit: number;
};

function readNodeTranscriptParams(value: unknown): CodexNodeSessionTranscriptParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session read parameters must be an object");
  }
  requireOnlyKeys(value, new Set(["threadId", "cursor", "limit"]));
  const threadId = readBoundedOptionalString(value, "threadId", MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    throw new CatalogParamsError("threadId is required");
  }
  const cursor = readBoundedOptionalString(value, "cursor", MAX_CURSOR_LENGTH);
  const limit = readBoundedLimit(
    value.limit,
    "limit",
    DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    MAX_TRANSCRIPT_PAGE_LIMIT,
  );
  return { threadId, limit, ...(cursor ? { cursor } : {}) };
}

function readBoundedLimit(value: unknown, key: string, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new CatalogParamsError(`${key} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function flattenTranscriptPageDesc(page: CodexThreadTurnsListResponse) {
  return page.data.flatMap((turn) => turn.items.toReversed());
}

/** Reads the persisted transcript for a Gateway-local or paired-node Codex session. */
export async function readCodexSessionTranscript(params: {
  agentId: string;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
  source?: CodexCatalogHome;
}): Promise<CodexSessionTranscriptPage> {
  if (params.source || params.hostId === CODEX_LOCAL_SESSION_HOST_ID) {
    await requireCatalogEligibleThread(params.control, params.threadId);
    const listParams = {
      threadId: params.threadId,
      limit: params.limit,
      sortDirection: "desc" as const,
      itemsView: "full" as const,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    };
    const response = await params.control.listTurnPage(listParams);
    const page = parseTranscriptPage(response);
    return {
      hostId: params.hostId,
      label: params.source?.label ?? "Local Codex",
      threadId: params.threadId,
      items: flattenTranscriptPageDesc(page),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
    };
  }

  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND),
  );
  if (!node) {
    throw new CatalogParamsError("paired-node Codex session host is offline or unavailable");
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    params: {
      agentId: params.agentId,
      threadId: params.threadId,
      limit: params.limit,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  const page = parseTranscriptPage(unwrapNodeInvokePayload(raw));
  return {
    hostId: params.hostId,
    label: nodeLabel(node),
    threadId: params.threadId,
    items: flattenTranscriptPageDesc(page),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
  };
}
