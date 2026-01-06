import path from "node:path";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam } from "./common.js";
import {
  classifySessionKind,
  deriveProvider,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  type SessionKind,
  stripToolMessages,
} from "./sessions-helpers.js";

type SessionListRow = {
  key: string;
  kind: SessionKind;
  provider: string;
  displayName?: string;
  updatedAt?: number | null;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  transcriptPath?: string;
  messages?: unknown[];
};

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  messageLimit: Type.Optional(Type.Integer({ minimum: 0 })),
});

function resolveSandboxSessionToolsVisibility(
  cfg: ReturnType<typeof loadConfig>,
) {
  return cfg.agent?.sandbox?.sessionToolsVisibility ?? "spawned";
}

export function createSessionsListTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    description: "List sessions with optional filters and last messages.",
    parameters: SessionsListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility = resolveSandboxSessionToolsVisibility(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        requesterInternalKey &&
        !requesterInternalKey.toLowerCase().startsWith("subagent:");

      const kindsRaw = readStringArrayParam(params, "kinds")?.map((value) =>
        value.trim().toLowerCase(),
      );
      const allowedKindsList = (kindsRaw ?? []).filter((value) =>
        ["main", "group", "cron", "hook", "node", "other"].includes(value),
      );
      const allowedKinds = allowedKindsList.length
        ? new Set(allowedKindsList)
        : undefined;

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const activeMinutes =
        typeof params.activeMinutes === "number" &&
        Number.isFinite(params.activeMinutes)
          ? Math.max(1, Math.floor(params.activeMinutes))
          : undefined;
      const messageLimitRaw =
        typeof params.messageLimit === "number" &&
        Number.isFinite(params.messageLimit)
          ? Math.max(0, Math.floor(params.messageLimit))
          : 0;
      const messageLimit = Math.min(messageLimitRaw, 20);

      const list = (await callGateway({
        method: "sessions.list",
        params: {
          limit,
          activeMinutes,
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? requesterInternalKey : undefined,
        },
      })) as {
        path?: string;
        sessions?: Array<Record<string, unknown>>;
      };

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const rows: SessionListRow[] = [];

      for (const entry of sessions) {
        if (!entry || typeof entry !== "object") continue;
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key) continue;
        if (key === "unknown") continue;
        if (key === "global" && alias !== "global") continue;

        const gatewayKind =
          typeof entry.kind === "string" ? entry.kind : undefined;
        const kind = classifySessionKind({ key, gatewayKind, alias, mainKey });
        if (allowedKinds && !allowedKinds.has(kind)) continue;

        const displayKey = resolveDisplaySessionKey({
          key,
          alias,
          mainKey,
        });

        const surface =
          typeof entry.surface === "string" ? entry.surface : undefined;
        const lastChannel =
          typeof entry.lastChannel === "string" ? entry.lastChannel : undefined;
        const provider = deriveProvider({
          key,
          kind,
          surface,
          lastChannel,
        });

        const sessionId =
          typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        const transcriptPath =
          sessionId && storePath
            ? path.join(path.dirname(storePath), `${sessionId}.jsonl`)
            : undefined;

        const row: SessionListRow = {
          key: displayKey,
          kind,
          provider,
          displayName:
            typeof entry.displayName === "string"
              ? entry.displayName
              : undefined,
          updatedAt:
            typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
          sessionId,
          model: typeof entry.model === "string" ? entry.model : undefined,
          contextTokens:
            typeof entry.contextTokens === "number"
              ? entry.contextTokens
              : undefined,
          totalTokens:
            typeof entry.totalTokens === "number"
              ? entry.totalTokens
              : undefined,
          thinkingLevel:
            typeof entry.thinkingLevel === "string"
              ? entry.thinkingLevel
              : undefined,
          verboseLevel:
            typeof entry.verboseLevel === "string"
              ? entry.verboseLevel
              : undefined,
          systemSent:
            typeof entry.systemSent === "boolean"
              ? entry.systemSent
              : undefined,
          abortedLastRun:
            typeof entry.abortedLastRun === "boolean"
              ? entry.abortedLastRun
              : undefined,
          sendPolicy:
            typeof entry.sendPolicy === "string" ? entry.sendPolicy : undefined,
          lastChannel,
          lastTo: typeof entry.lastTo === "string" ? entry.lastTo : undefined,
          transcriptPath,
        };

        if (messageLimit > 0) {
          const resolvedKey = resolveInternalSessionKey({
            key: displayKey,
            alias,
            mainKey,
          });
          const history = (await callGateway({
            method: "chat.history",
            params: { sessionKey: resolvedKey, limit: messageLimit },
          })) as { messages?: unknown[] };
          const rawMessages = Array.isArray(history?.messages)
            ? history.messages
            : [];
          const filtered = stripToolMessages(rawMessages);
          row.messages =
            filtered.length > messageLimit
              ? filtered.slice(-messageLimit)
              : filtered;
        }

        rows.push(row);
      }

      return jsonResult({
        count: rows.length,
        sessions: rows,
      });
    },
  };
}
