import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { sessionCatalogPaging } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { adoptedSourceKey, CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { continueClaudeSession } from "./session-catalog-continue.js";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";
import {
  assertClaudeLocalAccess,
  listClaudeSessionCatalog,
  readClaudeSessionTranscript,
  resolveNodeClaudeRecord,
} from "./session-catalog-listing.js";
import { MAX_TRANSCRIPT_LIMIT, readTranscriptParams } from "./session-catalog-parsing.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";
import { configuredClaudeConfigDir, gatewayClaudeScanOptions } from "./session-catalog-scan.js";
import { ClaudeCatalogParamsError } from "./session-catalog-shared.js";
import * as catalogTerminal from "./session-catalog-terminal.js";
import { collectTranscriptText, type ClaudeTranscriptItem } from "./session-catalog-transcript.js";
import type { ClaudeSessionCatalogHost } from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";

export * from "./session-catalog-shared.js";
export {
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog-listing.js";

const CLAUDE_TRANSCRIPT_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
  ["toolCall", "toolCall"],
  ["toolResult", "toolResult"],
]);
const CLAUDE_BLOCK_TYPES = new Map<unknown, SessionCatalogTranscriptItem["type"]>([
  ["thinking", "reasoning"],
  ["tool_use", "toolCall"],
  ["tool_result", "toolResult"],
]);

function toGenericClaudeItems(item: ClaudeTranscriptItem): SessionCatalogTranscriptItem[] {
  const common = {
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.truncated ? { truncated: true } : {}),
  };
  if (!Array.isArray(item.content)) {
    return [
      {
        ...common,
        ...(item.uuid ? { id: item.uuid } : {}),
        // Oversized rows lose their native blocks; their flattened text can contain
        // reasoning or tools, so consumers must not treat it as ordinary prose.
        type: item.truncated ? "other" : (CLAUDE_TRANSCRIPT_TYPES.get(item.type) ?? "other"),
        ...(item.text ? { text: item.text } : {}),
      },
    ];
  }
  // Mixed tools/reasoning must not inherit the row's user or assistant label.
  return item.content
    .flatMap((block, index): SessionCatalogTranscriptItem[] => {
      if (!isRecord(block)) {
        return [];
      }
      const messageType = item.type === "userMessage" ? "userMessage" : "agentMessage";
      const type =
        block.type === "text" ? messageType : (CLAUDE_BLOCK_TYPES.get(block.type) ?? "other");
      const fragments: string[] = [];
      if (block.type === "tool_use") {
        fragments.push(typeof block.name === "string" ? block.name : "tool");
        if (block.input !== undefined) {
          fragments.push(JSON.stringify(block.input));
        }
      } else {
        const content =
          block.type === "text" ? (typeof block.text === "string" ? block.text : "") : block;
        collectTranscriptText(content, fragments);
      }
      const text = fragments.join("\n\n");
      return [
        {
          ...common,
          ...(item.uuid ? { id: `${item.uuid}:${index}` } : {}),
          type,
          ...(text ? { text } : {}),
        },
      ];
    })
    .toReversed();
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
    canStartTerminal: host.kind === "gateway" ? cliAvailable : host.canStartTerminal === true,
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
        ...(session.color ? { color: session.color } : {}),
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
      const { threadId, limit, cursor } = readTranscriptParams({
        threadId: request.threadId,
        limit: request.limit,
        cursor: request.cursor,
      });
      const blockCursor = /^block:(\d+):(.+)$/u.exec(cursor ?? "");
      const skip = Number(blockCursor?.[1] ?? 0);
      if (!Number.isSafeInteger(skip) || (cursor?.startsWith("block:") && !blockCursor)) {
        throw new ClaudeCatalogParamsError("transcript cursor is invalid");
      }
      const page = await readClaudeSessionTranscript({
        runtime: api.runtime,
        hostId: request.hostId,
        threadId,
        cursor: blockCursor?.[2] ?? cursor,
        limit,
        allowProcessHomeFallback: request.allowProcessHomeFallback,
      });
      if (skip && !page.items.length) {
        throw new ClaudeCatalogParamsError("transcript cursor is invalid");
      }
      const projected = page.items.flatMap((row, index) => {
        const blocks = toGenericClaudeItems(row);
        const offset = index === 0 ? skip : 0;
        if (offset && offset >= blocks.length) {
          throw new ClaudeCatalogParamsError("transcript cursor is invalid");
        }
        return blocks.slice(offset).map((item, block) => ({ item, row, skip: offset + block }));
      });
      const { items } = sessionCatalogPaging.boundTranscriptPage(
        projected.map(({ item }) => item).toReversed(),
        limit,
        0,
      );
      for (const [index, item] of items.entries()) {
        if (item.text !== projected[index]?.item.text && projected[index]?.item.text) {
          item.truncated = true;
        }
      }
      const resume = projected[items.length];
      if (resume && !isExactClaudeSessionCursor(resume.row.resumeCursor)) {
        throw new Error("Update the Claude session node to page mixed transcript blocks");
      }
      // Native byte-end anchors use base64url (no colon), so the block prefix is
      // distinct. Anchors survive appends, changed page sizes, and byte-budget cuts.
      const nextCursor = resume
        ? `block:${resume.skip}:${resume.row.resumeCursor}`
        : page.nextCursor;
      return { ...page, items, nextCursor };
    },
    continueSession: async (request) => {
      assertClaudeLocalAccess(request.hostId, request.allowProcessHomeFallback);
      const agentId = resolveSessionAgentIdsStrict({
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
        if (request.hostId && request.hostId !== CLAUDE_LOCAL_SESSION_HOST_ID) {
          throw new ClaudeCatalogParamsError(
            "Claude terminal host is unavailable; select a listed host",
          );
        }
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
            resolveClaudeCatalogHomeDir(),
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
