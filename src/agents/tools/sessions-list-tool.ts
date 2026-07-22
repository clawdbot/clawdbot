/**
 * sessions_list built-in tool.
 *
 * Lists visible sessions and optionally hydrates titles, last messages, and transcript-derived metadata.
 */
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "../../gateway/session-transcript-readers.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getSessionStateVersions } from "../../sessions/session-state-events.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";
import {
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
} from "../schema/typebox.js";
import {
  describeSessionsListTool,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  classifySessionKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSandboxedSessionToolContext,
  type GatewaySessionListRow,
  type SessionListRow,
  type SessionRunStatus,
} from "./sessions-helpers.js";

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(Type.String())),
  limit: optionalPositiveIntegerSchema(),
  activeMinutes: optionalPositiveIntegerSchema(),
  messageLimit: optionalNonNegativeIntegerSchema(),
  label: Type.Optional(Type.String({ minLength: 1 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  search: Type.Optional(Type.String({ minLength: 1 })),
  archived: Type.Optional(Type.Boolean()),
  includeDerivedTitles: Type.Optional(Type.Boolean()),
  includeLastMessage: Type.Optional(Type.Boolean()),
});

const SessionListRowOutputSchema = Type.Object(
  {
    key: Type.String(),
    agentId: Type.String(),
    kind: Type.Union([
      Type.Literal("main"),
      Type.Literal("group"),
      Type.Literal("cron"),
      Type.Literal("hook"),
      Type.Literal("node"),
      Type.Literal("other"),
    ]),
    channel: Type.String(),
    archived: Type.Boolean(),
    pinned: Type.Boolean(),
    label: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
    derivedTitle: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    parentSessionKey: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.Number()),
    stateVersion: Type.Optional(Type.Number()),
    model: Type.Optional(Type.String()),
    contextTokens: Type.Optional(Type.Number()),
    totalTokens: Type.Optional(Type.Number()),
    status: Type.Optional(
      Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("killed"),
        Type.Literal("timeout"),
      ]),
    ),
    abortedLastRun: Type.Optional(Type.Boolean()),
    childSessions: Type.Optional(Type.Array(Type.String())),
    messages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);

const SessionsListOutputSchema = Type.Object(
  {
    count: Type.Number(),
    sessions: Type.Array(SessionListRowOutputSchema),
    visibility: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([Type.Literal("self"), Type.Literal("tree"), Type.Literal("agent")]),
          restricted: Type.Literal(true),
          warning: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type GatewayCaller = typeof callGateway;

const SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS = 100;

function readSessionRunStatus(value: unknown): SessionRunStatus | undefined {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : undefined;
}

/** Creates the sessions-list tool with gateway-backed listing and local transcript enrichment. */
export function createSessionsListTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    displaySummary: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsListTool(),
    parameters: SessionsListToolSchema,
    outputSchema: SessionsListOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, requesterInternalKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const effectiveRequesterKey = requesterInternalKey ?? alias;
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const kindsRaw = readStringArrayParam(params, "kinds")
        ?.map((value) => normalizeOptionalLowercaseString(value))
        .filter((value): value is string => Boolean(value));
      const allowedKindsList = (kindsRaw ?? []).filter((value) =>
        ["main", "group", "cron", "hook", "node", "other"].includes(value),
      );
      const allowedKinds = allowedKindsList.length ? new Set(allowedKindsList) : undefined;

      const limit = readPositiveIntegerParam(params, "limit");
      const activeMinutes = readPositiveIntegerParam(params, "activeMinutes");
      const messageLimitRaw = readNonNegativeIntegerParam(params, "messageLimit") ?? 0;
      const messageLimit = Math.min(messageLimitRaw, 20);
      const label = readStringParam(params, "label");
      const agentId = readStringParam(params, "agentId");
      const search = readStringParam(params, "search");
      const archived = params.archived === true;
      const includeDerivedTitles = params.includeDerivedTitles === true;
      const includeLastMessage = params.includeLastMessage === true;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const hydrateTranscriptFieldsAfterFiltering = includeDerivedTitles || includeLastMessage;

      const list = await gatewayCall<{ sessions: Array<GatewaySessionListRow>; path: string }>({
        method: "sessions.list",
        params: {
          limit,
          activeMinutes,
          label,
          agentId,
          search,
          archived,
          includeDerivedTitles: false,
          includeLastMessage: false,
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
        },
      });

      // Cross-session tool output is copied into durable transcripts, so exposing
      // incognito rows here would defeat their process-only lifetime.
      const sessions = (Array.isArray(list?.sessions) ? list.sessions : []).filter(
        (entry) => !entry || typeof entry !== "object" || !isIncognitoSessionKey(entry.key),
      );
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const stateVersions = getSessionStateVersions(
        sessions.flatMap((entry) =>
          entry && typeof entry === "object" && typeof entry.key === "string"
            ? [
                {
                  sessionKey: entry.key,
                  agentId:
                    typeof entry.agentId === "string" && entry.agentId
                      ? entry.agentId
                      : resolveAgentIdFromSessionKey(entry.key, defaultAgentId),
                },
              ]
            : [],
        ),
      );
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const visibilityGuard = createSessionVisibilityRowChecker({
        action: "list",
        defaultAgentId,
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const rows: SessionListRow[] = [];
      const historyTargets: Array<{ row: SessionListRow; resolvedKey: string }> = [];
      const titleTargets: Array<{
        row: SessionListRow;
        titleEntry: SessionEntry;
        sessionEntry: { sessionFile?: string; sessionId: string };
        sessionId: string;
        sessionKey: string;
        agentId: string;
      }> = [];

      for (const entry of sessions) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key) {
          continue;
        }
        const access = visibilityGuard.check({
          key,
          agentId: typeof entry.agentId === "string" ? entry.agentId : undefined,
          ownerSessionKey:
            typeof (entry as { ownerSessionKey?: unknown }).ownerSessionKey === "string"
              ? (entry as { ownerSessionKey?: string }).ownerSessionKey
              : undefined,
          spawnedBy: typeof entry.spawnedBy === "string" ? entry.spawnedBy : undefined,
          parentSessionKey:
            typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : undefined,
        });
        if (!access.allowed) {
          continue;
        }

        // Gateway listings include pseudo/global rows for UI callers. The tool only exposes real
        // sessions and the explicit global session when the requester is already global.
        if (key === "unknown") {
          continue;
        }
        if (key === "global" && alias !== "global") {
          continue;
        }

        const gatewayKind = typeof entry.kind === "string" ? entry.kind : undefined;
        const kind = classifySessionKind({ key, gatewayKind, alias, mainKey });
        if (allowedKinds && !allowedKinds.has(kind)) {
          continue;
        }

        const displayKey = resolveDisplaySessionKey({
          key,
          alias,
          mainKey,
        });

        const entryChannel = readStringValue(entry.channel);
        const entryOrigin = entry.origin as Record<string, unknown> | undefined;
        const originChannel =
          typeof entryOrigin?.provider === "string" ? entryOrigin.provider : undefined;
        const deliveryContext = entry.deliveryContext;
        const deliveryChannel = readStringValue(deliveryContext?.channel);
        const lastChannel = deliveryChannel ?? readStringValue(entry.lastChannel);
        const derivedChannel = deriveChannel({
          key,
          kind,
          channel: entryChannel ?? originChannel,
          lastChannel,
        });

        const sessionId = readStringValue(entry.sessionId);
        const sessionFileRaw = (entry as { sessionFile?: unknown }).sessionFile;
        const sessionFile = readStringValue(sessionFileRaw);
        const resolvedAgentId = resolveAgentIdFromSessionKey(key, defaultAgentId);
        // Version lookup keys on the store-owning agent (gateway row agentId), not the
        // key-derived agent: bare "global" keys parse to the default agent id.
        const stateVersionAgentId =
          typeof entry.agentId === "string" && entry.agentId ? entry.agentId : resolvedAgentId;
        const stateVersion = stateVersions[stateVersionAgentId]?.[key];
        const rowLabel = readStringValue(entry.label);
        const displayName = readStringValue(entry.displayName);
        const derivedTitle = readStringValue(entry.derivedTitle);
        const lastMessagePreview = readStringValue(entry.lastMessagePreview);
        const parentSessionKeyRaw =
          typeof entry.parentSessionKey === "string"
            ? entry.parentSessionKey
            : typeof entry.spawnedBy === "string"
              ? entry.spawnedBy
              : undefined;
        const parentSessionKey = parentSessionKeyRaw
          ? isIncognitoSessionKey(parentSessionKeyRaw)
            ? undefined
            : resolveDisplaySessionKey({
                key: parentSessionKeyRaw,
                alias,
                mainKey,
              })
          : undefined;
        const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : undefined;
        const model = readStringValue(entry.model);
        const contextTokens =
          typeof entry.contextTokens === "number" ? entry.contextTokens : undefined;
        const totalTokens = typeof entry.totalTokens === "number" ? entry.totalTokens : undefined;
        const status = readSessionRunStatus(entry.status);
        const abortedLastRun =
          typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined;
        const childSessions = Array.isArray(entry.childSessions)
          ? entry.childSessions
              .filter(
                (value): value is string =>
                  typeof value === "string" && !isIncognitoSessionKey(value),
              )
              .map((value) =>
                resolveDisplaySessionKey({
                  key: value,
                  alias,
                  mainKey,
                }),
              )
          : undefined;
        const row: SessionListRow = {
          key: displayKey,
          agentId: resolvedAgentId,
          kind,
          channel: derivedChannel,
          archived: entry.archived === true,
          pinned: entry.pinned === true,
          ...(rowLabel ? { label: rowLabel } : {}),
          ...(displayName ? { displayName } : {}),
          ...(derivedTitle ? { derivedTitle } : {}),
          ...(lastMessagePreview ? { lastMessagePreview } : {}),
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(stateVersion ? { stateVersion } : {}),
          ...(model ? { model } : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(status ? { status } : {}),
          ...(abortedLastRun !== undefined ? { abortedLastRun } : {}),
          ...(childSessions ? { childSessions } : {}),
        };
        if (
          sessionId &&
          hydrateTranscriptFieldsAfterFiltering &&
          titleTargets.length < SESSIONS_LIST_TRANSCRIPT_FIELD_ROWS
        ) {
          titleTargets.push({
            row,
            titleEntry: {
              sessionId,
              displayName: row.displayName,
              label: row.label,
              subject: readStringValue((entry as { subject?: unknown }).subject),
              updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
            },
            sessionEntry: {
              sessionId,
              ...(sessionFile ? { sessionFile } : {}),
            },
            sessionId,
            sessionKey: resolveInternalSessionKey({
              key,
              alias,
              mainKey,
            }),
            agentId: resolvedAgentId,
          });
        }
        if (messageLimit > 0) {
          const resolvedKey = resolveInternalSessionKey({
            key,
            alias,
            mainKey,
          });
          historyTargets.push({ row, resolvedKey });
        }
        rows.push(row);
      }

      if (titleTargets.length > 0) {
        await pMap(
          titleTargets,
          async (target) => {
            const fields = await readSessionTitleFieldsFromTranscriptAsync({
              agentId: target.agentId,
              sessionEntry: target.sessionEntry,
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              storePath,
            });
            if (includeDerivedTitles && !target.row.derivedTitle) {
              target.row.derivedTitle = deriveSessionTitle(
                target.titleEntry,
                fields.firstUserMessage,
              );
            }
            if (includeLastMessage && fields.lastMessagePreview) {
              target.row.lastMessagePreview = fields.lastMessagePreview;
            }
          },
          { concurrency: 4, stopOnError: true },
        );
      }

      if (messageLimit > 0 && historyTargets.length > 0) {
        await pMap(
          historyTargets,
          async (target) => {
            const history = await gatewayCall<{ messages: Array<unknown> }>({
              method: "chat.history",
              params: { sessionKey: target.resolvedKey, limit: messageLimit },
            });
            const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
            const filtered = stripToolMessages(rawMessages);
            target.row.messages =
              filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
          },
          { concurrency: 4, stopOnError: true },
        );
      }

      const visibilityMetadata =
        visibility === "all"
          ? undefined
          : {
              mode: visibility,
              restricted: true,
              warning: `Session visibility is restricted (effective tools.sessions.visibility=${visibility}). Results may omit sessions outside the current scope. The count field reflects only sessions within the current scope.`,
            };

      return jsonResult({
        count: rows.length,
        sessions: rows,
        ...(visibilityMetadata ? { visibility: visibilityMetadata } : {}),
      });
    },
  };
}
