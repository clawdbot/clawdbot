import { resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { adoptedSourceKey, CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { continueClaudeSession } from "./session-catalog-continue.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import {
  assertClaudeLocalAccess,
  listClaudeSessionCatalog,
  readClaudeSessionTranscript,
  resolveNodeClaudeRecord,
} from "./session-catalog-listing.js";
import { DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT } from "./session-catalog-parsing.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";
import {
  configuredClaudeConfigDir,
  currentHomeDir,
  gatewayClaudeScanOptions,
} from "./session-catalog-scan.js";
import * as catalogTerminal from "./session-catalog-terminal.js";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";
import type { ClaudeSessionCatalogHost } from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";

export * from "./session-catalog-shared.js";
export {
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog-listing.js";

function toGenericClaudeItem(item: ClaudeTranscriptItem): SessionCatalogTranscriptItem {
  const allowed = new Set<SessionCatalogTranscriptItem["type"]>([
    "userMessage",
    "agentMessage",
    "reasoning",
    "toolCall",
    "toolResult",
    "other",
  ]);
  const type = allowed.has(item.type as SessionCatalogTranscriptItem["type"])
    ? (item.type as SessionCatalogTranscriptItem["type"])
    : "other";
  return {
    ...(item.uuid ? { id: item.uuid } : {}),
    type,
    ...(item.text ? { text: item.text } : {}),
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.truncated ? { truncated: true } : {}),
    ...(item.content !== undefined
      ? { raw: item.content as SessionCatalogTranscriptItem["raw"] }
      : {}),
  };
}

function toGenericClaudeHost(
  host: ClaudeSessionCatalogHost,
  adopted: ReadonlyMap<string, string>,
  cliAvailable: boolean,
): SessionCatalogHost {
  return {
    hostId: host.hostId,
    label: host.label,
    kind: host.kind,
    connected: host.connected,
    ...(host.nodeId ? { nodeId: host.nodeId } : {}),
    sessions: host.sessions.map((session) => {
      const terminal = catalogTerminal.terminalEligibility(host, session.source, cliAvailable);
      const nodeCli =
        host.kind === "node" && host.canContinueClaude === true && session.source === "claude-cli";
      const existingSessionKey = adopted.get(adoptedSourceKey(host.hostId, session.threadId));
      // Already-adopted rows stay continuable even if node policy later denies
      // the run command: continue only returns the existing session key, and
      // the turn itself still fails closed at invoke time.
      const continuable = terminal.localResumable || nodeCli || Boolean(existingSessionKey);
      return {
        threadId: session.threadId,
        ...(session.name ? { name: session.name } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        status: session.status,
        ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
        ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
        ...(session.recencyAt != null ? { recencyAt: session.recencyAt } : {}),
        source: session.source,
        modelProvider: session.modelProvider,
        ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        ...(session.customGroup ? { customGroup: session.customGroup } : {}),
        ...(session.pullRequest ? { pullRequest: session.pullRequest } : {}),
        archived: session.archived,
        ...(continuable && existingSessionKey ? { sessionKey: existingSessionKey } : {}),
        canContinue: continuable,
        canArchive: false,
        canOpenTerminal: terminal.canOpenTerminal,
      };
    }),
    ...(host.nextCursor ? { nextCursor: host.nextCursor } : {}),
    ...(host.error ? { error: host.error } : {}),
  };
}

type ClaudeSessionCatalogRuntime = Required<
  Pick<
    SessionCatalogProvider,
    | "list"
    | "read"
    | "continueSession"
    | "startTerminalSession"
    | "openTerminal"
    | "checkUpstreamActivity"
  >
>;

export function createClaudeSessionCatalogRuntime(
  api: OpenClawPluginApi,
): ClaudeSessionCatalogRuntime {
  return {
    list: async (query) => {
      const adopted = listBoundClaudeSessions(api, query.agentId, query.sessionEntries);
      const localCliAvailable = catalogTerminal.isClaudeCliAvailable();
      const {
        allowProcessHomeFallback,
        agentId: _agentId,
        listNodes,
        onHost,
        sessionEntries: _sessionEntries,
        ...gatewayQuery
      } = query;
      const mapHost = (host: ClaudeSessionCatalogHost) =>
        toGenericClaudeHost(host, adopted, localCliAvailable);
      const result = await listClaudeSessionCatalog({
        runtime: api.runtime,
        query: gatewayQuery,
        allowProcessHomeFallback,
        listNodes,
        ...(onHost ? { onHost: (host) => onHost(mapHost(host)) } : {}),
      });
      return result.hosts.map(mapHost);
    },
    read: async (request) => {
      const { agentId: _agentId, allowProcessHomeFallback, ...catalogRequest } = request;
      const page = await readClaudeSessionTranscript({
        runtime: api.runtime,
        hostId: catalogRequest.hostId,
        threadId: catalogRequest.threadId,
        cursor: catalogRequest.cursor,
        limit: catalogRequest.limit ?? DEFAULT_TRANSCRIPT_LIMIT,
        allowProcessHomeFallback,
      });
      return { ...page, items: page.items.map(toGenericClaudeItem) };
    },
    continueSession: async (request) => {
      assertClaudeLocalAccess(request.hostId, request.allowProcessHomeFallback);
      const agentId = resolveSessionAgentIds({
        config: api.config,
        agentId: request.agentId,
      }).sessionAgentId;
      return await continueClaudeSession(
        api,
        agentId,
        request.hostId,
        request.threadId,
        request.allowProcessHomeFallback,
      );
    },
    startTerminalSession: async (request) => {
      // Node launches run in the paired node's environment, not gateway HOME;
      // only local starts fall under the process-HOME isolation guard.
      if (!request.nodeId) {
        assertClaudeLocalAccess(CLAUDE_LOCAL_SESSION_HOST_ID, request.allowProcessHomeFallback);
      }
      return await catalogTerminal.startClaudeCatalogTerminal(request);
    },
    openTerminal: async (request) => {
      assertClaudeLocalAccess(request.hostId, request.allowProcessHomeFallback);
      return await catalogTerminal.openClaudeCatalogTerminal({
        api,
        ...request,
        listClaudeSessions: () =>
          listClaudeSessions(
            currentHomeDir(),
            gatewayClaudeScanOptions(request.allowProcessHomeFallback),
          ),
        resolveNodeClaudeRecord,
      });
    },
    checkUpstreamActivity: async (probes, policy) => {
      const localAllowed =
        policy?.allowProcessHomeFallback !== false || configuredClaudeConfigDir() !== undefined;
      const eligible = probes.filter(
        (probe) => probe.hostId !== CLAUDE_LOCAL_SESSION_HOST_ID || localAllowed,
      );
      return await upstream.checkClaudeUpstreamActivity(eligible, async (probe) => {
        return (
          await readClaudeSessionTranscript({
            runtime: api.runtime,
            hostId: probe.hostId,
            threadId: probe.threadId,
            limit: MAX_TRANSCRIPT_LIMIT,
            allowProcessHomeFallback: policy?.allowProcessHomeFallback,
          })
        ).items;
      });
    },
  };
}
