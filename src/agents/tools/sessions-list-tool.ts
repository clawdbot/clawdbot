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
import type { SessionRunStatus } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "../../gateway/session-transcript-title-reader.js";
import { deriveSessionTitle } from "../../gateway/session-utils.js";
import { classifySessionKeyShape, isIncognitoSessionKey } from "../../routing/session-key.js";
import { getSessionStateVersions } from "../../sessions/session-state-events.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
} from "../schema/typebox.js";
import {
  describeSessionsListTool,
  describeSessionVisibilityScope,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  classifySessionListKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSandboxedSessionToolContext,
  type GatewaySessionListRow,
  type SessionListRow,
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
    sessionId: Type.Optional(Type.String()),
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

type GatewayCaller = AgentToolGatewayRequestCaller;

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
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    displaySummary: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsListTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsListToolSchema,
    outputSchema: SessionsListOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, requesterInternalKey, mainSessionKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          requesterAgentId: opts?.requesterAgentIdOverride,
          sandboxed: opts?.sandboxed,
        });
      const effectiveRequesterKey = requesterInternalKey ?? alias;
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
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
      const label = readToolStringParam(params, "label");
      const agentId = readToolStringParam(params, "agentId");
      const search = readToolStringParam(params, "search");
      const archived = params.archived === true;
      const includeDerivedTitles = params.includeDerivedTitles === true;
      const includeLastMessage = params.includeLastMessage === true;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const hydrateTranscriptFieldsAfterFiltering = includeDerivedTitles || includeLastMessage;
      const defaultAgentId = requesterAgentId;
      const visibilityGuard = createSessionVisibilityRowChecker({
        action: "list",
        defaultAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      });
      const sessions: GatewaySessionListRow[] = [];
      const seenKeys = new Set<string>();
      const resolvedAgentIdsByKey = new Map<string, string>();
      const outputLimit = limit ?? 100;
      let offset = 0;
      let storePath: string | undefined;
      for (let pageIndex = 0; sessions.length < outputLimit; pageIndex += 1) {
        const page = await gatewayCall<{
          sessions?: GatewaySessionListRow[];
          path?: string;
          hasMore?: boolean;
          nextOffset?: number | null;
        }>({
          method: "sessions.list",
          params: {
            limit: 200,
            offset,
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
        storePath ??= typeof page?.path === "string" ? page.path : undefined;
        const pageSessions = Array.isArray(page?.sessions) ? page.sessions : [];
        for (const entry of pageSessions) {
          const key =
            entry && typeof entry === "object" && typeof entry.key === "string" ? entry.key : "";
          if (!key || seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          // Cross-session tool output is copied into durable transcripts, so exposing
          // incognito rows here would defeat their process-only lifetime.
          if (isIncognitoSessionKey(key)) {
            continue;
          }
          if (classifySessionKeyShape(key) === "malformed_agent") {
            // A malformed scoped key is not an unscoped fixed-store row. Treating
            // it as bare would let the compatibility owner adopt invalid input.
            continue;
          }
          let resolvedAgentId: string;
          try {
            resolvedAgentId = resolveSessionToolTargetAgentId({
              cfg,
              targetSessionKey: key,
              resolvedAgentId:
                typeof entry.agentId === "string" && entry.agentId ? entry.agentId : undefined,
              requesterAgentId,
            });
          } catch {
            // An unowned fixed-store row is unavailable rather than adopted by the requester.
            continue;
          }
          const access = visibilityGuard.check({
            key,
            agentId: resolvedAgentId,
            ownerSessionKey:
              typeof (entry as { ownerSessionKey?: unknown }).ownerSessionKey === "string"
                ? (entry as { ownerSessionKey?: string }).ownerSessionKey
                : undefined,
            spawnedBy: typeof entry.spawnedBy === "string" ? entry.spawnedBy : undefined,
            parentSessionKey:
              typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : undefined,
          });
          const kind = classifySessionListKind(entry);
          if (
            access.allowed &&
            key !== "unknown" &&
            (key !== "global" || alias === "global") &&
            (!allowedKinds || allowedKinds.has(kind))
          ) {
            resolvedAgentIdsByKey.set(key, resolvedAgentId);
            sessions.push(entry);
            if (sessions.length === outputLimit) {
              break;
            }
          }
        }
        if (sessions.length === outputLimit || page?.hasMore !== true) {
          break;
        }
        const nextOffset = page.nextOffset;
        if (
          typeof nextOffset !== "number" ||
          !Number.isSafeInteger(nextOffset) ||
          nextOffset !== offset + pageSessions.length
        ) {
          throw new Error(
            `sessions.list returned invalid pagination metadata (offset=${offset}, nextOffset=${String(nextOffset)})`,
          );
        }
        // Bound unstable Gateway snapshots by both request count and scanned rows.
        if (pageIndex >= 49 || nextOffset > 10_000) {
          throw new Error("sessions.list exceeded the 50-page/10,000-row pagination scan limit");
        }
        offset = nextOffset;
      }

      const stateVersions = getSessionStateVersions(
        sessions.flatMap((entry) => {
          const key = entry.key;
          const stateAgentId = resolvedAgentIdsByKey.get(key);
          if (!stateAgentId) {
            return [];
          }
          return [{ sessionKey: key, agentId: stateAgentId }];
        }),
      );
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
        const key = entry.key;
        const resolvedAgentId = resolvedAgentIdsByKey.get(key);
        if (!resolvedAgentId) {
          continue;
        }
        const kind = classifySessionListKind(entry);
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
          ...(sessionId ? { sessionId } : {}),
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
              params: {
                sessionKey: target.resolvedKey,
                agentId: target.row.agentId,
                limit: messageLimit,
              },
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
              warning: `Session visibility is restricted (effective tools.sessions.visibility=${visibility}: ${describeSessionVisibilityScope(visibility, { spawnRestricted: restrictToSpawned })}). Sessions outside that scope are omitted from results and count.`,
            };

      return jsonResult({
        count: rows.length,
        sessions: rows,
        ...(visibilityMetadata ? { visibility: visibilityMetadata } : {}),
      });
    },
  };
}
