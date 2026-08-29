import process from "node:process";
import { resolveAcpSessionAvailability } from "openclaw/plugin-sdk/acp-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSessionCatalogFamily,
  importSessionCatalogHistory,
  listAdoptedSessionCatalogSessions,
  sessionCatalogAdoptedSessionKey,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  PI_LOCAL_SESSION_HOST_ID,
  PI_SESSIONS_LIST_COMMAND,
  PI_SESSION_CATALOG_MAX_HOSTS,
  PI_SESSION_CATALOG_MAX_PAGE_LIMIT,
  PI_SESSION_ID_PATTERN,
  PI_SESSION_READ_COMMAND,
  PI_TERMINAL_RESUME_COMMAND,
} from "./pi-session-catalog-shared.js";
import {
  isExactPiSessionCursor,
  listLocalPiSessionPage,
  readLocalPiTranscriptPage,
} from "./pi-session-catalog.js";
import { piSessionStore, piSessionStoreAvailable } from "./pi-session-paths.js";
import { checkPiUpstreamActivity, linkContinuedPiSession } from "./pi-session-upstream-activity.js";

const NODE_TIMEOUT_MS = 20_000;
const ACPX_BACKEND_ID = "acpx";
const PI_ACP_AGENT_ID = "pi";
const PI_ADOPTED_SESSION_KEY_PREFIX = "plugin:acpx:catalog-adopt:pi:";

export async function requireLocalPiSession(threadId: string): Promise<SessionCatalogSession> {
  const page = await listLocalPiSessionPage({
    searchTerm: threadId,
    limit: PI_SESSION_CATALOG_MAX_PAGE_LIMIT,
  });
  const session = page.sessions.find((candidate) => candidate.threadId === threadId);
  if (!session) {
    throw new Error("Pi session is unavailable");
  }
  return session;
}

function currentPiCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

function resolvePiContinuationAvailability(
  api: OpenClawPluginApi,
): { available: true } | { available: false; message: string } {
  const availability = resolveAcpSessionAvailability({
    config: currentPiCatalogConfig(api),
    backendId: ACPX_BACKEND_ID,
    agentId: PI_ACP_AGENT_ID,
  });
  if (!availability.available) {
    return availability;
  }
  const executable = resolveNodeHostExecutable("pi", {
    env: process.env,
    pathEnv: process.env.PATH ?? "",
    strategy: "fallback",
  });
  return executable ? { available: true } : { available: false, message: "Pi CLI is unavailable" };
}

function listAdoptedPiSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Map<string, string> {
  return listAdoptedSessionCatalogSessions({
    ...(agentId ? { agentId } : {}),
    config: currentPiCatalogConfig(api),
    pluginId: api.id,
    runtime: api.runtime,
    sessionEntries,
    sourceFromEntry: (entry) => {
      const acpx = isRecord(entry.pluginExtensions?.acpx) ? entry.pluginExtensions.acpx : undefined;
      const marker = acpx && isRecord(acpx.piSessionCatalog) ? acpx.piSessionCatalog : undefined;
      return marker && typeof marker.sourceThreadId === "string"
        ? { hostId: PI_LOCAL_SESSION_HOST_ID, threadId: marker.sourceThreadId }
        : undefined;
    },
  });
}

async function createAdoptedPiSession(params: {
  api: OpenClawPluginApi;
  agentId: string;
  hostId: string;
  threadId: string;
  session: SessionCatalogSession;
}): Promise<{ sessionKey: string }> {
  const config = currentPiCatalogConfig(params.api);
  const marker = { sourceThreadId: params.threadId };
  const created = await params.api.runtime.agent.session.createSessionEntry({
    cfg: config,
    key: sessionCatalogAdoptedSessionKey(PI_ADOPTED_SESSION_KEY_PREFIX, params.threadId),
    agentId: params.agentId,
    recoverMatchingInitialEntry: true,
    ...(params.session.name ? { label: params.session.name } : {}),
    ...(params.session.cwd ? { spawnedCwd: params.session.cwd } : {}),
    initialEntry: {
      acpBackendId: ACPX_BACKEND_ID,
      acpSessionBinding: {
        acpAgentId: PI_ACP_AGENT_ID,
        agentSessionId: params.threadId,
      },
      pluginExtensions: { acpx: { piSessionCatalog: marker } },
    },
    afterCreate: async (entry) => {
      await importSessionCatalogHistory({
        catalogId: "pi",
        threadId: params.threadId,
        read: async ({ cursor, limit }) =>
          await readLocalPiTranscriptPage({
            threadId: params.threadId,
            limit,
            ...(cursor ? { cursor } : {}),
          }),
        sessionId: entry.sessionId,
        sessionKey: entry.key,
        agentId: entry.agentId,
        ...(params.session.cwd ? { cwd: params.session.cwd } : {}),
        config,
      });
      return { pluginExtensions: { acpx: { piSessionCatalog: marker } } };
    },
  });
  return { sessionKey: created.key };
}

function assertPiLocalAccess(hostId: string, allowProcessHomeFallback?: boolean): void {
  if (
    hostId === PI_LOCAL_SESSION_HOST_ID &&
    allowProcessHomeFallback === false &&
    piSessionStore(process.env).usesProcessHomeFallback
  ) {
    throw new Error("local Pi sessions are unavailable in isolated state");
  }
}

export async function listPiSessions(params: unknown) {
  return await listLocalPiSessionPage(params);
}

export async function readPiSession(params: unknown) {
  return await readLocalPiTranscriptPage(params);
}

export function createPiSessionCatalogRuntime(api: OpenClawPluginApi) {
  return createSessionCatalogFamily(
    {
      runtime: api.runtime,
      local: {
        hostId: PI_LOCAL_SESSION_HOST_ID,
        label: "Local Pi",
        available: (query) => {
          const store = piSessionStore(process.env);
          return (
            (query.allowProcessHomeFallback !== false || !store.usesProcessHomeFallback) &&
            piSessionStoreAvailable(process.env, store)
          );
        },
        list: async (query) =>
          await listLocalPiSessionPage({
            limit: query.limitPerHost,
            ...(query.search ? { searchTerm: query.search } : {}),
            cursor: query.cursors?.[PI_LOCAL_SESSION_HOST_ID],
          }),
        read: async (request) =>
          await readLocalPiTranscriptPage({
            threadId: request.threadId,
            ...(request.limit ? { limit: request.limit } : {}),
            ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
          }),
        assertAccess: assertPiLocalAccess,
      },
      node: {
        listCommand: PI_SESSIONS_LIST_COMMAND,
        readCommand: PI_SESSION_READ_COMMAND,
        terminalCommand: PI_TERMINAL_RESUME_COMMAND,
        timeoutMs: NODE_TIMEOUT_MS,
        maxHosts: PI_SESSION_CATALOG_MAX_HOSTS,
        maxPageLimit: PI_SESSION_CATALOG_MAX_PAGE_LIMIT,
        sessionIdPattern: PI_SESSION_ID_PATTERN,
      },
      capabilities: {
        local: () => ({
          canContinue: resolvePiContinuationAvailability(api).available,
          canOpenTerminal:
            resolveNodeHostExecutable("pi", {
              env: process.env,
              pathEnv: process.env.PATH ?? "",
              strategy: "fallback",
            }) !== undefined,
        }),
        node: (node) => {
          const commands = node.invocableCommands ?? node.commands;
          return {
            canContinue: false,
            canOpenTerminal: commands?.includes(PI_TERMINAL_RESUME_COMMAND) === true,
          };
        },
        project: (session, capabilities) => ({
          ...session,
          canContinue: capabilities.canContinue && session.canContinue,
          canOpenTerminal: capabilities.canOpenTerminal,
        }),
      },
      messages: {
        invalidNodeCursor: "Pi node returned an invalid cursor",
        invalidNodeSessionPage: "Pi node returned an invalid session page",
        invalidNodeTranscriptPage: "Pi node returned an invalid transcript page",
        invalidHostId: "Pi session catalog hostId is invalid",
        localReadFailed: "Local Pi sessions are unavailable",
        nodeInvokeFailed: "Paired node Pi sessions are unavailable",
        nodeReadUnavailable: "paired-node Pi session host is unavailable",
        nodeTerminalUnavailable: "paired-node Pi terminal is unavailable",
        sessionUnavailable: "Pi session is unavailable",
      },
      continuation: {
        resolveAgentId: (agentId) =>
          resolveSessionAgentIdsStrict({ config: api.config, agentId }).sessionAgentId,
        availability: () => resolvePiContinuationAvailability(api),
        listAdopted: (agentId, sessionEntries) =>
          listAdoptedPiSessions(api, agentId, sessionEntries),
        loadSession: requireLocalPiSession,
        validateSession: (session) => {
          if (!session.canContinue) {
            throw new Error("Pi session is outside the session store supported by pi-acp");
          }
        },
        create: async (params) => await createAdoptedPiSession({ api, ...params }),
        complete: async (continued, threadId) =>
          await linkContinuedPiSession(continued.sessionKey, threadId),
        nodeReadOnlyMessage: "paired-node Pi session rows are view-only",
      },
      terminal: {
        executable: "pi",
        args: (threadId) => ["--session", threadId],
        title: (threadId) => `pi --session ${threadId.slice(0, 12)}…`,
        requireLocalSession: requireLocalPiSession,
        unavailableMessage: "Pi CLI is unavailable",
      },
      checkUpstreamActivity: (probes, policy) =>
        checkPiUpstreamActivity(
          probes.filter(
            (probe) =>
              probe.hostId !== PI_LOCAL_SESSION_HOST_ID ||
              policy?.allowProcessHomeFallback !== false ||
              !piSessionStore(process.env).usesProcessHomeFallback,
          ),
        ),
    },
    isExactPiSessionCursor,
  );
}
