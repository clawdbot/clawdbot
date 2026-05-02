import path from "node:path";
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
import {
  deriveSessionTitle,
  readSessionTitleFieldsFromTranscriptAsync,
} from "../../gateway/session-utils.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString, readStringValue } from "../../shared/string-coerce.js";
import {
  describeSessionsListTool,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  classifySessionKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSandboxedSessionToolContext,
  type SessionListRow,
  type SessionRunStatus,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  messageLimit: Type.Optional(Type.Number({ minimum: 0 })),
  label: Type.Optional(Type.String({ minLength: 1 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  search: Type.Optional(Type.String({ minLength: 1 })),
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

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const activeMinutes =
        typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)
          ? Math.max(1, Math.floor(params.activeMinutes))
          : undefined;
      const messageLimitRaw =
        typeof params.messageLimit === "number" && Number.isFinite(params.messageLimit)
          ? Math.max(0, Math.floor(params.messageLimit))
          : 0;
      const messageLimit = Math.min(messageLimitRaw, 20);
      const label = readStringParam(params, "label");
      const agentId = readStringParam(params, "agentId");
      const search = readStringParam(params, "search");
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
          includeDerivedTitles: false,
          includeLastMessage: false,
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
        },
      });

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const visibilityGuard = await createSessionVisibilityGuard({
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
        sessionId: string;
        sessionFile?: string;
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
        const access = visibilityGuard.check(key);
        if (!access.allowed) {
          continue;
        }

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
        const deliveryContext =
          entry.deliveryContext && typeof entry.deliveryContext === "object"
            ? (entry.deliveryContext as Record<string, unknown>)
            : undefined;
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
          sessionId,
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
          fastMode: typeof entry.fastMode === "boolean" ? entry.fastMode : undefined,
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
            sessionId,
            ...(sessionFile ? { sessionFile } : {}),
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
        const maxConcurrent = Math.min(4, titleTargets.length);
        let index = 0;
        const worker = async () => {
          while (true) {
            const next = index;
            index += 1;
            if (next >= titleTargets.length) {
              return;
            }
            const target = titleTargets[next];
            const fields = await readSessionTitleFieldsFromTranscriptAsync(
              target.sessionId,
              storePath,
              target.sessionFile,
              target.agentId,
            );
            if (includeDerivedTitles && !target.row.derivedTitle) {
              target.row.derivedTitle = deriveSessionTitle(
                target.titleEntry,
                fields.firstUserMessage,
              );
            }
            if (includeLastMessage && fields.lastMessagePreview) {
              target.row.lastMessagePreview = fields.lastMessagePreview;
            }
          }
        };
        await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
      }

      if (messageLimit > 0 && historyTargets.length > 0) {
        const maxConcurrent = Math.min(4, historyTargets.length);
        let index = 0;
        const worker = async () => {
          while (true) {
            const next = index;
            index += 1;
            if (next >= historyTargets.length) {
              return;
            }
            const target = historyTargets[next];
            const history = await gatewayCall<{ messages: Array<unknown> }>({
              method: "chat.history",
              params: { sessionKey: target.resolvedKey, limit: messageLimit },
            });
            const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
            const filtered = stripToolMessages(rawMessages);
            target.row.messages =
              filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
          }
        };
        await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
      }

      return jsonResult({
        count: rows.length,
        sessions: rows,
      });
    },
  };
}
