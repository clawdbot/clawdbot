/**
 * sessions_list built-in tool.
 *
 * Lists visible sessions and optionally hydrates titles, last messages, and transcript-derived metadata.
 */
import path from "node:path";
import {
  normalizeFastMode,
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "../../gateway/session-transcript-readers.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getSessionStateVersions } from "../../sessions/session-state-events.js";
import { normalizeFastModeAutoOnSeconds, normalizeFastModeSource } from "../../shared/fast-mode.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
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

      const list = await gatewayCall<{ sessions: Array<SessionListRow>; path: string }>({
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

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const stateVersions = getSessionStateVersions(
        sessions.flatMap((entry) =>
          entry && typeof entry === "object" && typeof entry.key === "string"
            ? [
                {
                  sessionKey: entry.key,
                  agentId:
                    typeof entry.agentId === "string" && entry.agentId
                      ? entry.agentId
                      : resolveAgentIdFromSessionKey(entry.key),
                },
              ]
            : [],
        ),
      );
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const visibilityGuard = createSessionVisibilityRowChecker({
        action: "list",
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

        const entryChannel = typeof entry.channel === "string" ? entry.channel : undefined;
        const entryOrigin =
          entry.origin && typeof entry.origin === "object"
            ? (entry.origin as Record<string, unknown>)
            : undefined;
        const originChannel =
          typeof entryOrigin?.provider === "string" ? entryOrigin.provider : undefined;
        const deliveryContext = deliveryContextFromSession(entry);
        const deliveryChannel = readStringValue(deliveryContext?.channel);
        const deliveryTo = readStringValue(deliveryContext?.to);
        const deliveryAccountId = readStringValue(deliveryContext?.accountId);
        const deliveryThreadId =
          typeof deliveryContext?.threadId === "string" ||
          (typeof deliveryContext?.threadId === "number" &&
            Number.isFinite(deliveryContext.threadId))
            ? deliveryContext.threadId
            : undefined;
        const lastChannel = deliveryChannel ?? readStringValue(entry.lastChannel);
        const lastAccountId = deliveryAccountId ?? readStringValue(entry.lastAccountId);
        const derivedChannel = deriveChannel({
          key,
          kind,
          channel: entryChannel ?? originChannel,
          lastChannel,
        });

        const sessionId = readStringValue(entry.sessionId);
        const sessionFileRaw = (entry as { sessionFile?: unknown }).sessionFile;
        const sessionFile = readStringValue(sessionFileRaw);
        const resolvedAgentId = resolveAgentIdFromSessionKey(key);
        let transcriptPath: string | undefined;
        if (sessionId) {
          try {
            const trimmedStorePath = storePath?.trim();
            let effectiveStorePath: string | undefined;
            if (trimmedStorePath && trimmedStorePath !== "(multiple)") {
              if (trimmedStorePath.includes("{agentId}") || trimmedStorePath.startsWith("~")) {
                effectiveStorePath = resolveStorePath(trimmedStorePath, {
                  agentId: resolvedAgentId,
                });
              } else if (path.isAbsolute(trimmedStorePath)) {
                effectiveStorePath = trimmedStorePath;
              }
            }
            const filePathOpts = resolveSessionFilePathOptions({
              agentId: resolvedAgentId,
              storePath: effectiveStorePath,
            });
            transcriptPath = resolveSessionFilePath(
              sessionId,
              sessionFile ? { sessionFile } : undefined,
              filePathOpts,
            );
          } catch {
            transcriptPath = undefined;
          }
        }

        const effectiveFastMode = normalizeFastMode(entry.effectiveFastMode);
        const effectiveFastModeSource = normalizeFastModeSource(entry.effectiveFastModeSource);
        const fastAutoOnSeconds = normalizeFastModeAutoOnSeconds(entry.fastAutoOnSeconds);
        // Version lookup keys on the store-owning agent (gateway row agentId), not the
        // key-derived agent: bare "global" keys parse to the default agent id.
        const stateVersionAgentId =
          typeof entry.agentId === "string" && entry.agentId ? entry.agentId : resolvedAgentId;
        const stateVersion = stateVersions[stateVersionAgentId]?.[key];
        const row: SessionListRow = {
          key: displayKey,
          agentId: resolvedAgentId,
          kind,
          channel: derivedChannel,
          origin:
            originChannel ||
            (typeof entryOrigin?.accountId === "string" ? entryOrigin.accountId : undefined)
              ? {
                  provider: originChannel,
                  accountId: readStringValue(entryOrigin?.accountId),
                }
              : undefined,
          spawnedBy:
            typeof entry.spawnedBy === "string"
              ? resolveDisplaySessionKey({
                  key: entry.spawnedBy,
                  alias,
                  mainKey,
                })
              : undefined,
          label: readStringValue(entry.label),
          displayName: readStringValue(entry.displayName),
          derivedTitle: readStringValue(entry.derivedTitle),
          lastMessagePreview: readStringValue(entry.lastMessagePreview),
          parentSessionKey:
            typeof entry.parentSessionKey === "string"
              ? resolveDisplaySessionKey({
                  key: entry.parentSessionKey,
                  alias,
                  mainKey,
                })
              : undefined,
          deliveryContext:
            deliveryChannel || deliveryTo || deliveryAccountId || deliveryThreadId
              ? {
                  channel: deliveryChannel,
                  to: deliveryTo,
                  accountId: deliveryAccountId,
                  threadId: deliveryThreadId,
                }
              : undefined,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
          archived: entry.archived === true,
          archivedAt: typeof entry.archivedAt === "number" ? entry.archivedAt : undefined,
          pinned: entry.pinned === true,
          pinnedAt: typeof entry.pinnedAt === "number" ? entry.pinnedAt : undefined,
          sessionId,
          ...(stateVersion ? { stateVersion } : {}),
          model: readStringValue(entry.model),
          contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : undefined,
          totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : undefined,
          estimatedCostUsd:
            typeof entry.estimatedCostUsd === "number" ? entry.estimatedCostUsd : undefined,
          status: readSessionRunStatus(entry.status),
          startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
          endedAt: typeof entry.endedAt === "number" ? entry.endedAt : undefined,
          runtimeMs: typeof entry.runtimeMs === "number" ? entry.runtimeMs : undefined,
          childSessions: Array.isArray(entry.childSessions)
            ? entry.childSessions
                .filter((value): value is string => typeof value === "string")
                .map((value) =>
                  resolveDisplaySessionKey({
                    key: value,
                    alias,
                    mainKey,
                  }),
                )
            : undefined,
          thinkingLevel: readStringValue(entry.thinkingLevel),
          fastMode: normalizeFastMode(entry.fastMode),
          ...(effectiveFastMode !== undefined ? { effectiveFastMode } : {}),
          ...(effectiveFastModeSource !== undefined ? { effectiveFastModeSource } : {}),
          ...(fastAutoOnSeconds !== undefined ? { fastAutoOnSeconds } : {}),
          verboseLevel: readStringValue(entry.verboseLevel),
          reasoningLevel: readStringValue(entry.reasoningLevel),
          elevatedLevel: readStringValue(entry.elevatedLevel),
          responseUsage: readStringValue(entry.responseUsage),
          systemSent: typeof entry.systemSent === "boolean" ? entry.systemSent : undefined,
          abortedLastRun:
            typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined,
          sendPolicy: readStringValue(entry.sendPolicy),
          lastChannel,
          lastTo: deliveryTo ?? readStringValue(entry.lastTo),
          lastAccountId,
          transcriptPath,
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
