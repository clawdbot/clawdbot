import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
  waitForEmbeddedPiRunEnd,
} from "../agents/pi-embedded.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { HealthSummary } from "../commands/health.js";
import {
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObject,
  writeConfigFile,
} from "../config/config.js";
import { buildConfigSchema } from "../config/schema.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  resolveMainSessionKeyFromConfig,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { registerAgentRunContext } from "../infra/agent-events.js";
import {
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "../infra/voicewake.js";
import { loadClawdbotPlugins } from "../plugins/loader.js";
import { clearCommandLane } from "../process/command-queue.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  type ChatAbortControllerEntry,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "./chat-abort.js";
import {
  type ChatImageContent,
  parseMessageWithAttachments,
} from "./chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type SessionsCompactParams,
  type SessionsDeleteParams,
  type SessionsListParams,
  type SessionsPatchParams,
  type SessionsResetParams,
  type SessionsResolveParams,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
  validateConfigGetParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
  validateModelsListParams,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateTalkModeParams,
} from "./protocol/index.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  HEALTH_REFRESH_INTERVAL_MS,
  MAX_CHAT_HISTORY_MESSAGES_BYTES,
} from "./server-constants.js";
import type { DedupeEntry } from "./server-shared.js";
import { normalizeVoiceWakeTriggers } from "./server-utils.js";
import {
  archiveFileOnDisk,
  capArrayByJsonBytes,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
} from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";
import { formatForLog } from "./ws-log.js";

export type BridgeHandlersContext = {
  deps: CliDeps;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  bridgeSendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
  ) => void;
  bridgeSubscribe: (nodeId: string, sessionKey: string) => void;
  bridgeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, number>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  agentRunSeq: Map<string, number>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  logBridge: { warn: (msg: string) => void };
};

export function createBridgeHandlers(ctx: BridgeHandlersContext) {
  const handleBridgeRequest = async (
    nodeId: string,
    req: { id: string; method: string; paramsJSON?: string | null },
  ): Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  > => {
    const method = req.method.trim();

    const parseParams = (): Record<string, unknown> => {
      const raw = typeof req.paramsJSON === "string" ? req.paramsJSON : "";
      const trimmed = raw.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    };

    try {
      switch (method) {
        case "voicewake.get": {
          const cfg = await loadVoiceWakeConfig();
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "voicewake.set": {
          const params = parseParams();
          const triggers = normalizeVoiceWakeTriggers(params.triggers);
          const cfg = await setVoiceWakeTriggers(triggers);
          ctx.broadcastVoiceWakeChanged(cfg.triggers);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
          };
        }
        case "health": {
          const now = Date.now();
          const cached = ctx.getHealthCache();
          if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
            return { ok: true, payloadJSON: JSON.stringify(cached) };
          }
          const snap = await ctx.refreshHealthSnapshot({ probe: false });
          return { ok: true, payloadJSON: JSON.stringify(snap) };
        }
        case "config.get": {
          const params = parseParams();
          if (!validateConfigGetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
              },
            };
          }
          const snapshot = await readConfigFileSnapshot();
          return { ok: true, payloadJSON: JSON.stringify(snapshot) };
        }
        case "config.schema": {
          const params = parseParams();
          if (!validateConfigSchemaParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
              },
            };
          }
          const cfg = loadConfig();
          const workspaceDir = resolveAgentWorkspaceDir(
            cfg,
            resolveDefaultAgentId(cfg),
          );
          const pluginRegistry = loadClawdbotPlugins({
            config: cfg,
            workspaceDir,
            logger: {
              info: () => {},
              warn: () => {},
              error: () => {},
              debug: () => {},
            },
          });
          const schema = buildConfigSchema({
            plugins: pluginRegistry.plugins.map((plugin) => ({
              id: plugin.id,
              name: plugin.name,
              description: plugin.description,
              configUiHints: plugin.configUiHints,
            })),
          });
          return { ok: true, payloadJSON: JSON.stringify(schema) };
        }
        case "config.set": {
          const params = parseParams();
          if (!validateConfigSetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
              },
            };
          }
          const rawValue = (params as { raw?: unknown }).raw;
          if (typeof rawValue !== "string") {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config.set params: raw (string) required",
              },
            };
          }
          const parsedRes = parseConfigJson5(rawValue);
          if (!parsedRes.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: parsedRes.error,
              },
            };
          }
          const validated = validateConfigObject(parsedRes.parsed);
          if (!validated.ok) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "invalid config",
                details: { issues: validated.issues },
              },
            };
          }
          await writeConfigFile(validated.config);
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              path: CONFIG_PATH_CLAWDBOT,
              config: validated.config,
            }),
          };
        }
        case "talk.mode": {
          const params = parseParams();
          if (!validateTalkModeParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
              },
            };
          }
          const payload = {
            enabled: (params as { enabled: boolean }).enabled,
            phase: (params as { phase?: string }).phase ?? null,
            ts: Date.now(),
          };
          ctx.broadcast("talk.mode", payload, { dropIfSlow: true });
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "models.list": {
          const params = parseParams();
          if (!validateModelsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
              },
            };
          }
          const models = await ctx.loadGatewayModelCatalog();
          return { ok: true, payloadJSON: JSON.stringify({ models }) };
        }
        case "sessions.list": {
          const params = parseParams();
          if (!validateSessionsListParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
              },
            };
          }
          const p = params as SessionsListParams;
          const cfg = loadConfig();
          const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
          const result = listSessionsFromStore({
            cfg,
            storePath,
            store,
            opts: p,
          });
          return { ok: true, payloadJSON: JSON.stringify(result) };
        }
        case "sessions.resolve": {
          const params = parseParams();
          if (!validateSessionsResolveParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.resolve params: ${formatValidationErrors(validateSessionsResolveParams.errors)}`,
              },
            };
          }

          const p = params as SessionsResolveParams;
          const cfg = loadConfig();
          const resolved = resolveSessionKeyFromResolveParams({ cfg, p });
          if (!resolved.ok) {
            return {
              ok: false,
              error: {
                code: resolved.error.code,
                message: resolved.error.message,
                details: resolved.error.details,
              },
            };
          }
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, key: resolved.key }),
          };
        }
        case "sessions.patch": {
          const params = parseParams();
          if (!validateSessionsPatchParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
              },
            };
          }

          const p = params as SessionsPatchParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const cfg = loadConfig();
          const target = resolveGatewaySessionStoreTarget({ cfg, key });
          const storePath = target.storePath;
          const store = loadSessionStore(storePath);
          const primaryKey = target.storeKeys[0] ?? key;
          const existingKey = target.storeKeys.find(
            (candidate) => store[candidate],
          );
          if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
            store[primaryKey] = store[existingKey];
            delete store[existingKey];
          }
          const applied = await applySessionsPatchToStore({
            cfg,
            store,
            storeKey: primaryKey,
            patch: p,
            loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
          });
          if (!applied.ok) {
            return {
              ok: false,
              error: {
                code: applied.error.code,
                message: applied.error.message,
                details: applied.error.details,
              },
            };
          }
          await saveSessionStore(storePath, store);
          const payload: SessionsPatchResult = {
            ok: true,
            path: storePath,
            key: target.canonicalKey,
            entry: applied.entry,
          };
          return { ok: true, payloadJSON: JSON.stringify(payload) };
        }
        case "sessions.reset": {
          const params = parseParams();
          if (!validateSessionsResetParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
              },
            };
          }

          const p = params as SessionsResetParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const { storePath, store, entry } = loadSessionEntry(key);
          const now = Date.now();
          const next: SessionEntry = {
            sessionId: randomUUID(),
            updatedAt: now,
            systemSent: false,
            abortedLastRun: false,
            thinkingLevel: entry?.thinkingLevel,
            verboseLevel: entry?.verboseLevel,
            reasoningLevel: entry?.reasoningLevel,
            model: entry?.model,
            contextTokens: entry?.contextTokens,
            sendPolicy: entry?.sendPolicy,
            label: entry?.label,
            displayName: entry?.displayName,
            chatType: entry?.chatType,
            channel: entry?.channel,
            subject: entry?.subject,
            room: entry?.room,
            space: entry?.space,
            lastChannel: entry?.lastChannel,
            lastTo: entry?.lastTo,
            skillsSnapshot: entry?.skillsSnapshot,
          };
          store[key] = next;
          await saveSessionStore(storePath, store);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ ok: true, key, entry: next }),
          };
        }
        case "sessions.delete": {
          const params = parseParams();
          if (!validateSessionsDeleteParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
              },
            };
          }

          const p = params as SessionsDeleteParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const mainKey = resolveMainSessionKeyFromConfig();
          if (key === mainKey) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `Cannot delete the main session (${mainKey}).`,
              },
            };
          }

          const deleteTranscript =
            typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          const existed = Boolean(store[key]);
          clearCommandLane(resolveEmbeddedSessionLane(key));
          if (sessionId && isEmbeddedPiRunActive(sessionId)) {
            abortEmbeddedPiRun(sessionId);
            const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
            if (!ended) {
              return {
                ok: false,
                error: {
                  code: ErrorCodes.UNAVAILABLE,
                  message: `Session ${key} is still active; try again in a moment.`,
                },
              };
            }
          }
          if (existed) delete store[key];
          await saveSessionStore(storePath, store);

          const archived: string[] = [];
          if (deleteTranscript && sessionId) {
            for (const candidate of resolveSessionTranscriptCandidates(
              sessionId,
              storePath,
              entry?.sessionFile,
            )) {
              if (!fs.existsSync(candidate)) continue;
              try {
                archived.push(archiveFileOnDisk(candidate, "deleted"));
              } catch {
                // Best-effort; deleting the store entry is the main operation.
              }
            }
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              deleted: existed,
              archived,
            }),
          };
        }
        case "sessions.compact": {
          const params = parseParams();
          if (!validateSessionsCompactParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
              },
            };
          }

          const p = params as SessionsCompactParams;
          const key = String(p.key ?? "").trim();
          if (!key) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "key required",
              },
            };
          }

          const maxLines =
            typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
              ? Math.max(1, Math.floor(p.maxLines))
              : 400;

          const { storePath, store, entry } = loadSessionEntry(key);
          const sessionId = entry?.sessionId;
          if (!sessionId) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no sessionId",
              }),
            };
          }

          const filePath = resolveSessionTranscriptCandidates(
            sessionId,
            storePath,
            entry?.sessionFile,
          ).find((candidate) => fs.existsSync(candidate));
          if (!filePath) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                reason: "no transcript",
              }),
            };
          }

          const raw = fs.readFileSync(filePath, "utf-8");
          const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length <= maxLines) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                key,
                compacted: false,
                kept: lines.length,
              }),
            };
          }

          const archived = archiveFileOnDisk(filePath, "bak");
          const keptLines = lines.slice(-maxLines);
          fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

          // Token counts no longer match; clear so status + UI reflect reality after the next turn.
          if (store[key]) {
            delete store[key].inputTokens;
            delete store[key].outputTokens;
            delete store[key].totalTokens;
            store[key].updatedAt = Date.now();
            await saveSessionStore(storePath, store);
          }

          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              key,
              compacted: true,
              archived,
              kept: keptLines.length,
            }),
          };
        }
        case "chat.history": {
          const params = parseParams();
          if (!validateChatHistoryParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
              },
            };
          }
          const { sessionKey, limit } = params as {
            sessionKey: string;
            limit?: number;
          };
          const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId;
          const rawMessages =
            sessionId && storePath
              ? readSessionMessages(sessionId, storePath, entry?.sessionFile)
              : [];
          const max = typeof limit === "number" ? limit : 200;
          const sliced =
            rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
          const capped = capArrayByJsonBytes(
            sliced,
            MAX_CHAT_HISTORY_MESSAGES_BYTES,
          ).items;
          let thinkingLevel = entry?.thinkingLevel;
          if (!thinkingLevel) {
            const configured = cfg.agents?.defaults?.thinkingDefault;
            if (configured) {
              thinkingLevel = configured;
            } else {
              const { provider, model } = resolveSessionModelRef(cfg, entry);
              const catalog = await ctx.loadGatewayModelCatalog();
              thinkingLevel = resolveThinkingDefault({
                cfg,
                provider,
                model,
                catalog,
              });
            }
          }
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              sessionKey,
              sessionId,
              messages: capped,
              thinkingLevel,
            }),
          };
        }
        case "chat.abort": {
          const params = parseParams();
          if (!validateChatAbortParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
              },
            };
          }

          const { sessionKey, runId } = params as {
            sessionKey: string;
            runId?: string;
          };
          const ops = {
            chatAbortControllers: ctx.chatAbortControllers,
            chatRunBuffers: ctx.chatRunBuffers,
            chatDeltaSentAt: ctx.chatDeltaSentAt,
            chatAbortedRuns: ctx.chatAbortedRuns,
            removeChatRun: ctx.removeChatRun,
            agentRunSeq: ctx.agentRunSeq,
            broadcast: ctx.broadcast,
            bridgeSendToSession: ctx.bridgeSendToSession,
          };
          if (!runId) {
            const res = abortChatRunsForSessionKey(ops, {
              sessionKey,
              stopReason: "rpc",
            });
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                aborted: res.aborted,
                runIds: res.runIds,
              }),
            };
          }
          const active = ctx.chatAbortControllers.get(runId);
          if (!active) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                aborted: false,
                runIds: [],
              }),
            };
          }
          if (active.sessionKey !== sessionKey) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: "runId does not match sessionKey",
              },
            };
          }
          const res = abortChatRunById(ops, {
            runId,
            sessionKey,
            stopReason: "rpc",
          });
          return {
            ok: true,
            payloadJSON: JSON.stringify({
              ok: true,
              aborted: res.aborted,
              runIds: res.aborted ? [runId] : [],
            }),
          };
        }
        case "chat.send": {
          const params = parseParams();
          if (!validateChatSendParams(params)) {
            return {
              ok: false,
              error: {
                code: ErrorCodes.INVALID_REQUEST,
                message: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
              },
            };
          }

          const p = params as {
            sessionKey: string;
            message: string;
            thinking?: string;
            deliver?: boolean;
            attachments?: Array<{
              type?: string;
              mimeType?: string;
              fileName?: string;
              content?: unknown;
            }>;
            timeoutMs?: number;
            idempotencyKey: string;
          };
          const stopCommand = isChatStopCommandText(p.message);
          const normalizedAttachments =
            p.attachments
              ?.map((a) => ({
                type: typeof a?.type === "string" ? a.type : undefined,
                mimeType:
                  typeof a?.mimeType === "string" ? a.mimeType : undefined,
                fileName:
                  typeof a?.fileName === "string" ? a.fileName : undefined,
                content:
                  typeof a?.content === "string"
                    ? a.content
                    : ArrayBuffer.isView(a?.content)
                      ? Buffer.from(
                          a.content.buffer,
                          a.content.byteOffset,
                          a.content.byteLength,
                        ).toString("base64")
                      : undefined,
              }))
              .filter((a) => a.content) ?? [];

          let parsedMessage = p.message;
          let parsedImages: ChatImageContent[] = [];
          if (normalizedAttachments.length > 0) {
            try {
              const parsed = await parseMessageWithAttachments(
                p.message,
                normalizedAttachments,
                { maxBytes: 5_000_000, log: ctx.logBridge },
              );
              parsedMessage = parsed.message;
              parsedImages = parsed.images;
            } catch (err) {
              return {
                ok: false,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: String(err),
                },
              };
            }
          }

          const { cfg, storePath, store, entry, canonicalKey } =
            loadSessionEntry(p.sessionKey);
          const timeoutMs = resolveAgentTimeoutMs({
            cfg,
            overrideMs: p.timeoutMs,
          });
          const now = Date.now();
          const sessionId = entry?.sessionId ?? randomUUID();
          const sessionEntry = mergeSessionEntry(entry, {
            sessionId,
            updatedAt: now,
          });
          const clientRunId = p.idempotencyKey;
          registerAgentRunContext(clientRunId, { sessionKey: p.sessionKey });

          if (stopCommand) {
            const res = abortChatRunsForSessionKey(
              {
                chatAbortControllers: ctx.chatAbortControllers,
                chatRunBuffers: ctx.chatRunBuffers,
                chatDeltaSentAt: ctx.chatDeltaSentAt,
                chatAbortedRuns: ctx.chatAbortedRuns,
                removeChatRun: ctx.removeChatRun,
                agentRunSeq: ctx.agentRunSeq,
                broadcast: ctx.broadcast,
                bridgeSendToSession: ctx.bridgeSendToSession,
              },
              { sessionKey: p.sessionKey, stopReason: "stop" },
            );
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                ok: true,
                aborted: res.aborted,
                runIds: res.runIds,
              }),
            };
          }

          const cached = ctx.dedupe.get(`chat:${clientRunId}`);
          if (cached) {
            if (cached.ok) {
              return { ok: true, payloadJSON: JSON.stringify(cached.payload) };
            }
            return {
              ok: false,
              error: cached.error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: "request failed",
              },
            };
          }

          const activeExisting = ctx.chatAbortControllers.get(clientRunId);
          if (activeExisting) {
            return {
              ok: true,
              payloadJSON: JSON.stringify({
                runId: clientRunId,
                status: "in_flight",
              }),
            };
          }

          try {
            const abortController = new AbortController();
            ctx.chatAbortControllers.set(clientRunId, {
              controller: abortController,
              sessionId,
              sessionKey: p.sessionKey,
              startedAtMs: now,
              expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
            });
            ctx.addChatRun(clientRunId, {
              sessionKey: p.sessionKey,
              clientRunId,
            });

            if (store) {
              store[canonicalKey] = sessionEntry;
              if (storePath) {
                await saveSessionStore(storePath, store);
              }
            }

            const ackPayload = {
              runId: clientRunId,
              status: "started" as const,
            };
            void agentCommand(
              {
                message: parsedMessage,
                images: parsedImages.length > 0 ? parsedImages : undefined,
                sessionId,
                sessionKey: p.sessionKey,
                runId: clientRunId,
                thinking: p.thinking,
                deliver: p.deliver,
                timeout: Math.ceil(timeoutMs / 1000).toString(),
                messageChannel: `node(${nodeId})`,
                abortSignal: abortController.signal,
              },
              defaultRuntime,
              ctx.deps,
            )
              .then(() => {
                ctx.dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: true,
                  payload: { runId: clientRunId, status: "ok" as const },
                });
              })
              .catch((err) => {
                const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
                ctx.dedupe.set(`chat:${clientRunId}`, {
                  ts: Date.now(),
                  ok: false,
                  payload: {
                    runId: clientRunId,
                    status: "error" as const,
                    summary: String(err),
                  },
                  error,
                });
              })
              .finally(() => {
                ctx.chatAbortControllers.delete(clientRunId);
              });

            return { ok: true, payloadJSON: JSON.stringify(ackPayload) };
          } catch (err) {
            const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
            const payload = {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            };
            ctx.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: false,
              payload,
              error,
            });
            return {
              ok: false,
              error: error ?? {
                code: ErrorCodes.UNAVAILABLE,
                message: String(err),
              },
            };
          }
        }
        default:
          return {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "Method not allowed",
              details: { method },
            },
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: ErrorCodes.INVALID_REQUEST, message: String(err) },
      };
    }
  };

  const handleBridgeEvent = async (
    nodeId: string,
    evt: { event: string; payloadJSON?: string | null },
  ) => {
    switch (evt.event) {
      case "voice.transcript": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!text) return;
        if (text.length > 20_000) return;
        const sessionKeyRaw =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        const cfg = loadConfig();
        const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
        const { storePath, store, entry, canonicalKey } =
          loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[canonicalKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          systemSent: entry?.systemSent,
          sendPolicy: entry?.sendPolicy,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
        // This maps agent bus events (keyed by sessionId) to chat events (keyed by clientRunId).
        ctx.addChatRun(sessionId, {
          sessionKey,
          clientRunId: `voice-${randomUUID()}`,
        });

        void agentCommand(
          {
            message: text,
            sessionId,
            sessionKey,
            thinking: "low",
            deliver: false,
            messageChannel: "node",
          },
          defaultRuntime,
          ctx.deps,
        ).catch((err) => {
          ctx.logBridge.warn(
            `agent failed node=${nodeId}: ${formatForLog(err)}`,
          );
        });
        return;
      }
      case "agent.request": {
        if (!evt.payloadJSON) return;
        type AgentDeepLink = {
          message?: string;
          sessionKey?: string | null;
          thinking?: string | null;
          deliver?: boolean;
          to?: string | null;
          channel?: string | null;
          timeoutSeconds?: number | null;
          key?: string | null;
        };
        let link: AgentDeepLink | null = null;
        try {
          link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
        } catch {
          return;
        }
        const message = (link?.message ?? "").trim();
        if (!message) return;
        if (message.length > 20_000) return;

        const channelRaw =
          typeof link?.channel === "string" ? link.channel.trim() : "";
        const channel = normalizeChannelId(channelRaw) ?? undefined;
        const to =
          typeof link?.to === "string" && link.to.trim()
            ? link.to.trim()
            : undefined;
        const deliver = Boolean(link?.deliver) && Boolean(channel);

        const sessionKeyRaw = (link?.sessionKey ?? "").trim();
        const sessionKey =
          sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
        const { storePath, store, entry, canonicalKey } =
          loadSessionEntry(sessionKey);
        const now = Date.now();
        const sessionId = entry?.sessionId ?? randomUUID();
        store[canonicalKey] = {
          sessionId,
          updatedAt: now,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          systemSent: entry?.systemSent,
          sendPolicy: entry?.sendPolicy,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
        };
        if (storePath) {
          await saveSessionStore(storePath, store);
        }

        void agentCommand(
          {
            message,
            sessionId,
            sessionKey,
            thinking: link?.thinking ?? undefined,
            deliver,
            to,
            channel,
            timeout:
              typeof link?.timeoutSeconds === "number"
                ? link.timeoutSeconds.toString()
                : undefined,
            messageChannel: "node",
          },
          defaultRuntime,
          ctx.deps,
        ).catch((err) => {
          ctx.logBridge.warn(
            `agent failed node=${nodeId}: ${formatForLog(err)}`,
          );
        });
        return;
      }
      case "chat.subscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        ctx.bridgeSubscribe(nodeId, sessionKey);
        return;
      }
      case "chat.unsubscribe": {
        if (!evt.payloadJSON) return;
        let payload: unknown;
        try {
          payload = JSON.parse(evt.payloadJSON) as unknown;
        } catch {
          return;
        }
        const obj =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : {};
        const sessionKey =
          typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
        if (!sessionKey) return;
        ctx.bridgeUnsubscribe(nodeId, sessionKey);
        return;
      }
      default:
        return;
    }
  };

  return { handleBridgeRequest, handleBridgeEvent };
}
