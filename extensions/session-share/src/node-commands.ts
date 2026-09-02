import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import {
  projectSessionCatalogSourceActor,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitle,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sessionShareGroups } from "./config.js";

export const SESSION_SHARE_LIST_COMMAND = "openclaw.sessions.list.v1";
export const SESSION_SHARE_READ_COMMAND = "openclaw.sessions.read.v1";
export const SESSION_SHARE_COMMANDS = [SESSION_SHARE_LIST_COMMAND, SESSION_SHARE_READ_COMMAND];

const parameterMessages = {
  listNotObject: "Session list parameters must be an object",
  unknownListParameter: (key: string) => `Unknown session list parameter: ${key}`,
  invalidSearchTerm: "searchTerm must be a non-empty string of at most 500 characters",
  readNotObject: "Session read parameters must be an object",
  unknownReadParameter: (key: string) => `Unknown session read parameter: ${key}`,
  invalidThreadId: "threadId must be a non-empty session key of at most 512 characters",
};

function parseNodeParams(paramsJSON?: string | null): unknown {
  return paramsJSON ? JSON.parse(paramsJSON) : undefined;
}

function sharedEntries(api: OpenClawPluginApi) {
  const config = api.runtime.config.current();
  const groups = new Set(sessionShareGroups(config));
  if (groups.size === 0) {
    return [];
  }
  return listAgentIds(config)
    .toSorted()
    .flatMap((agentId) =>
      api.runtime.agent.session
        .listSessionEntries({ agentId, readOnly: true })
        .map((session) => Object.assign({}, session, { agentId })),
    )
    .filter(
      ({ sessionKey, entry }) =>
        entry.category !== undefined &&
        groups.has(entry.category) &&
        entry.incognito !== true &&
        entry.visibility !== "draft" &&
        !/^agent:[^:]+:catalog:/i.test(sessionKey),
    );
}

export function createSessionShareNodeCommands(
  api: OpenClawPluginApi,
): OpenClawPluginNodeHostCommand[] {
  const source = { pluginId: "session-share", sourceDomain: "openclaw" };
  return [
    {
      command: SESSION_SHARE_LIST_COMMAND,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareGroups(config).length > 0,
      async handle(paramsJSON) {
        const params = sessionCatalogPaging.parseListParams(parseNodeParams(paramsJSON), {
          searchMaxLength: 500,
          messages: parameterMessages,
        });
        const offset = sessionCatalogPaging.decodeCursor(params.cursor);
        const search = params.searchTerm?.toLowerCase();
        const sessions: SessionCatalogSession[] = [];
        for (const { agentId, sessionKey, entry } of sharedEntries(api)) {
          const name = readSessionTranscriptCatalogTitle({ agentId, sessionKey, entry });
          if (
            search &&
            !name?.toLowerCase().includes(search) &&
            !sessionKey.toLowerCase().includes(search)
          ) {
            continue;
          }
          const archived = entry.archivedAt !== undefined;
          const cwd =
            entry.execCwd ??
            entry.spawnedCwd ??
            entry.spawnedWorkspaceDir ??
            entry.worktree?.canonicalWorkspaceDir ??
            entry.worktree?.repoRoot;
          sessions.push({
            threadId: sessionKey,
            name,
            color: entry.color,
            cwd: cwd ? redactToolPayloadText(cwd).slice(0, 6000) : undefined,
            status: archived ? "archived" : "idle",
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            recencyAt: Math.max(
              entry.updatedAt,
              entry.lastInteractionAt ?? 0,
              entry.lastActivityAt ?? 0,
            ),
            gitBranch: entry.worktree?.branch
              ? redactToolPayloadText(entry.worktree.branch).slice(0, 6000)
              : undefined,
            archived,
            canContinue: false,
            canArchive: false,
            canOpenTerminal: false,
            createdActor: projectSessionCatalogSourceActor({
              ...source,
              actor: entry.createdActor,
            }),
          });
        }
        sessions.sort(
          (left, right) =>
            (right.recencyAt ?? 0) - (left.recencyAt ?? 0) ||
            left.threadId.localeCompare(right.threadId),
        );
        const page = sessions.slice(offset, offset + params.limit);
        return JSON.stringify({
          sessions: page,
          ...(offset + page.length < sessions.length
            ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + page.length) }
            : {}),
        });
      },
    },
    {
      command: SESSION_SHARE_READ_COMMAND,
      cap: "openclaw-sessions",
      dangerous: false,
      isAvailable: ({ config }) => sessionShareGroups(config).length > 0,
      async handle(paramsJSON) {
        const params = sessionCatalogPaging.parseReadParams(parseNodeParams(paramsJSON), {
          threadIdMaxLength: 512,
          threadIdPattern: /^[^\0\r\n]+$/,
          cursorMaxLength: 1200,
          messages: parameterMessages,
        });
        const session = sharedEntries(api).find(({ sessionKey }) => sessionKey === params.threadId);
        if (!session) {
          throw new Error(
            "Session is not shared. The source operator must select its group and keep it non-draft.",
          );
        }
        const page = await readSessionTranscriptCatalogPage({
          ...source,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          limit: params.limit,
          cursor: params.cursor,
        });
        // Group changes and deletion revoke access even while an async transcript read is in flight.
        if (
          !sharedEntries(api).some(
            ({ agentId, sessionKey, entry }) =>
              agentId === session.agentId &&
              sessionKey === session.sessionKey &&
              entry.sessionId === session.entry.sessionId,
          )
        ) {
          throw new Error("Session is no longer shared. Refresh the session catalog.");
        }
        return JSON.stringify({ threadId: session.sessionKey, ...page });
      },
    },
  ];
}

export function createSessionShareNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: SESSION_SHARE_COMMANDS,
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}
