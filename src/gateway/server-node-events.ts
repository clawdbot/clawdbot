import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import {
  agentCommandFromIngress,
  buildOutboundSessionContext,
  createOutboundSendDeps,
  defaultRuntime,
  deleteMediaBuffer,
  deliverOutboundPayloads,
  enqueueSystemEvent,
  formatForLog,
  loadConfig,
  loadOrCreateDeviceIdentity,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  normalizeChannelId,
  normalizeMainKey,
  normalizeRpcAttachmentsToChatAttachments,
  parseMessageWithAttachments,
  registerApnsRegistration,
  requestHeartbeatNow,
  resolveGatewayModelSupportsImages,
  resolveOutboundTarget,
  resolveSessionAgentId,
  resolveSessionModelRef,
  sanitizeInboundSystemTags,
  scopedHeartbeatWakeOptions,
  updateSessionStore,
} from "./server-node-events.runtime.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
const recentExecFinishedRuns = new Map<string, number>();

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function resolveVoiceTranscriptFingerprint(obj: Record<string, unknown>, text: string): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    while (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
      const oldestKey = recentVoiceTranscripts.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      recentVoiceTranscripts.delete(oldestKey);
    }
  }

  return false;
}

function shouldDropDuplicateExecFinished(params: {
  sessionKey: string;
  runId: string;
  now: number;
}): boolean {
  const fingerprint = `${params.sessionKey}::${params.runId}`;
  const previousTs = recentExecFinishedRuns.get(fingerprint);
  if (
    typeof previousTs === "number" &&
    params.now - previousTs <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentExecFinishedRuns.set(fingerprint, params.now);
  if (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
    const cutoff = params.now - EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS;
    for (const [key, ts] of recentExecFinishedRuns) {
      if (ts < cutoff) {
        recentExecFinishedRuns.delete(key);
      }
      if (recentExecFinishedRuns.size <= MAX_RECENT_EXEC_FINISHED_RUNS) {
        break;
      }
    }
    while (recentExecFinishedRuns.size > MAX_RECENT_EXEC_FINISHED_RUNS) {
      const oldestKey = recentExecFinishedRuns.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      recentExecFinishedRuns.delete(oldestKey);
    }
  }

  return false;
}

export function resetNodeEventDeduplicationForTests() {
  recentVoiceTranscripts.clear();
  recentExecFinishedRuns.clear();
}

function compactExecEventOutput(raw: string) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_EXEC_EVENT_OUTPUT_CHARS) {
    return normalized;
  }
  const safe = Math.max(1, MAX_EXEC_EVENT_OUTPUT_CHARS - 1);
  return `${normalized.slice(0, safe)}…`;
}

function compactNotificationEventText(raw: string) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_NOTIFICATION_EVENT_TEXT_CHARS) {
    return normalized;
  }
  const safe = Math.max(1, MAX_NOTIFICATION_EVENT_TEXT_CHARS - 1);
  return `${normalized.slice(0, safe)}…`;
}

type LoadedSessionEntry = ReturnType<typeof loadSessionEntry>;

async function touchSessionStore(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg: params.cfg,
      key: params.sessionKey,
      store,
    });
    store[primaryKey] = {
      ...store[primaryKey],
      sessionId: params.sessionId,
      updatedAt: params.now,
      thinkingLevel: params.entry?.thinkingLevel,
      fastMode: params.entry?.fastMode,
      verboseLevel: params.entry?.verboseLevel,
      reasoningLevel: params.entry?.reasoningLevel,
      systemSent: params.entry?.systemSent,
      sendPolicy: params.entry?.sendPolicy,
      lastChannel: params.entry?.lastChannel,
      lastTo: params.entry?.lastTo,
      lastAccountId: params.entry?.lastAccountId,
      lastThreadId: params.entry?.lastThreadId,
    };
  });
}

function queueSessionStoreTouch(params: {
  ctx: NodeEventContext;
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  void touchSessionStore({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    canonicalKey: params.canonicalKey,
    entry: params.entry,
    sessionId: params.sessionId,
    now: params.now,
  }).catch((err) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
  });
}

function parseSessionKeyFromPayloadJSON(payloadJSON: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJSON) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  return sessionKey.length > 0 ? sessionKey : null;
}

function parsePayloadObject(payloadJSON?: string | null): Record<string, unknown> | null {
  if (!payloadJSON) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJSON) as unknown;
  } catch {
    return null;
  }
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

async function sendReceiptAck(params: {
  cfg: OpenClawConfig;
  deps: NodeEventContext["deps"];
  sessionKey: string;
  channel: string;
  to: string;
  text: string;
}) {
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    mode: "explicit",
  });
  if (!resolved.ok) {
    throw new Error(String(resolved.error));
  }
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel: params.channel,
    to: resolved.to,
    payloads: [{ text: params.text }],
    session,
    bestEffort: true,
    deps: createOutboundSendDeps(params.deps),
  });
}

export const handleNodeEvent = async (ctx: NodeEventContext, nodeId: string, evt: NodeEvent) => {
  switch (evt.event) {
    case "voice.transcript": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const text = normalizeOptionalString(obj.text) ?? "";
      if (!text) {
        return;
      }
      if (text.length > 20_000) {
        return;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
      const cfg = loadConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
      const now = Date.now();
      const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
      if (shouldDropDuplicateVoiceTranscript({ sessionKey: canonicalKey, fingerprint, now })) {
        return;
      }
      const sessionId = entry?.sessionId ?? randomUUID();
      queueSessionStoreTouch({
        ctx,
        cfg,
        sessionKey,
        storePath,
        canonicalKey,
        entry,
        sessionId,
        now,
      });
      const runId = randomUUID();

      // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
      // This maps agent bus events (keyed by per-turn runId) to chat events (keyed by clientRunId).
      ctx.addChatRun(runId, {
        sessionKey: canonicalKey,
        clientRunId: `voice-${randomUUID()}`,
      });

      void agentCommandFromIngress(
        {
          runId,
          message: text,
          sessionId,
          sessionKey: canonicalKey,
          thinking: "low",
          deliver: false,
          messageChannel: "node",
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "voice",
            sourceTool: "gateway.voice.transcript",
          },
          senderIsOwner: false,
          allowModelOverride: false,
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return;
      }
      type AgentDeepLink = {
        message?: string;
        sessionKey?: string | null;
        thinking?: string | null;
        deliver?: boolean;
        attachments?: Array<{
          type?: string;
          mimeType?: string;
          fileName?: string;
          content?: unknown;
        }> | null;
        receipt?: boolean;
        receiptText?: string | null;
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

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
      const cfg = loadConfig();
      const { storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);

      let message = (link?.message ?? "").trim();
      const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
        link?.attachments ?? undefined,
      );
      let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      let imageOrder: PromptImageOrderEntry[] = [];
      if (!message && normalizedAttachments.length === 0) {
        return;
      }
      if (message.length > 20_000) {
        return;
      }
      if (normalizedAttachments.length > 0) {
        const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
        const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
        const supportsImages = await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
          provider: modelRef.provider,
          model: modelRef.model,
        });
        try {
          const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
            maxBytes: 5_000_000,
            log: ctx.logGateway,
            supportsImages,
          });
          message = parsed.message.trim();
          images = parsed.images;
          imageOrder = parsed.imageOrder;
          if (message.length > 20_000) {
            ctx.logGateway.warn(
              `agent.request message exceeds limit after attachment parsing (length=${message.length})`,
            );
            if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) {
              for (const ref of parsed.offloadedRefs) {
                try {
                  await deleteMediaBuffer(ref.id);
                } catch (cleanupErr) {
                  ctx.logGateway.warn(
                    `Failed to cleanup orphaned media ${ref.id}: ${formatErrorMessage(cleanupErr)}`,
                  );
                }
              }
            }
            return;
          }
        } catch (err) {
          ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(err)}`);
          return;
        }
      }

      if (!message && images.length === 0) {
        return;
      }

      const channelRaw = normalizeOptionalString(link?.channel) ?? "";
      let channel = normalizeChannelId(channelRaw) ?? undefined;
      let to = normalizeOptionalString(link?.to);
      const deliverRequested = Boolean(link?.deliver);
      const wantsReceipt = Boolean(link?.receipt);
      const receiptText =
        normalizeOptionalString(link?.receiptText) ||
        "Just received your iOS share + request, working on it.";

      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      await touchSessionStore({ cfg, sessionKey, storePath, canonicalKey, entry, sessionId, now });

      if (deliverRequested && (!channel || !to)) {
        const entryChannel =
          typeof entry?.lastChannel === "string"
            ? normalizeChannelId(entry.lastChannel)
            : undefined;
        const entryTo = normalizeOptionalString(entry?.lastTo) ?? "";
        if (!channel && entryChannel) {
          channel = entryChannel;
        }
        if (!to && entryTo) {
          to = entryTo;
        }
      }
      const deliver = deliverRequested && Boolean(channel && to);
      const deliveryChannel = deliver ? channel : undefined;
      const deliveryTo = deliver ? to : undefined;
      if (deliverRequested && !deliver) {
        ctx.logGateway.warn(
          `agent delivery disabled node=${nodeId}: missing session delivery route (channel=${channel ?? "-"} to=${to ?? "-"})`,
        );
      }

      if (wantsReceipt && deliveryChannel && deliveryTo) {
        void sendReceiptAck({
          cfg,
          deps: ctx.deps,
          sessionKey: canonicalKey,
          channel: deliveryChannel,
          to: deliveryTo,
          text: receiptText,
        }).catch((err) => {
          ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(err)}`);
        });
      } else if (wantsReceipt) {
        ctx.logGateway.warn(
          `agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`,
        );
      }

      void agentCommandFromIngress(
        {
          runId: sessionId,
          message,
          images,
          imageOrder,
          sessionId,
          sessionKey: canonicalKey,
          thinking: link?.thinking ?? undefined,
          deliver,
          to: deliveryTo,
          channel: deliveryChannel,
          timeout:
            typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
          messageChannel: "node",
          senderIsOwner: false,
          allowModelOverride: false,
        },
        defaultRuntime,
        ctx.deps,
      ).catch((err) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      return;
    }
    case "notifications.changed": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const change = normalizeOptionalString(obj.change)
        ? normalizeLowercaseStringOrEmpty(obj.change)
        : undefined;
      if (change !== "posted" && change !== "removed") {
        return;
      }
      const keyRaw = normalizeOptionalString(obj.key);
      if (!keyRaw) {
        return;
      }
      const key = sanitizeInboundSystemTags(keyRaw);
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);
      const packageNameRaw = normalizeOptionalString(obj.packageName);
      const packageName = packageNameRaw ? sanitizeInboundSystemTags(packageNameRaw) : null;
      const title = compactNotificationEventText(
        sanitizeInboundSystemTags(normalizeOptionalString(obj.title) ?? ""),
      );
      const text = compactNotificationEventText(
        sanitizeInboundSystemTags(normalizeOptionalString(obj.text) ?? ""),
      );

      let summary = `Notification ${change} (node=${nodeId} key=${key}`;
      if (packageName) {
        summary += ` package=${packageName}`;
      }
      summary += ")";
      if (change === "posted") {
        const messageParts = [title, text].filter(Boolean);
        if (messageParts.length > 0) {
          summary += `: ${messageParts.join(" - ")}`;
        }
      }

      const queued = enqueueSystemEvent(summary, {
        sessionKey,
        contextKey: `notification:${keyRaw}`,
        trusted: false,
      });
      if (queued) {
        requestHeartbeatNow({ reason: "notifications-event", sessionKey });
      }
      return;
    }
    case "chat.subscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return;
      }
      ctx.nodeSubscribe(nodeId, sessionKey);
      return;
    }
    case "chat.unsubscribe": {
      if (!evt.payloadJSON) {
        return;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return;
      }
      ctx.nodeUnsubscribe(nodeId, sessionKey);
      return;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      if (!sessionKeyRaw) {
        return;
      }
      const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);

      // Respect tools.exec.notifyOnExit setting (default: true)
      // When false, skip system event notifications for node exec events.
      const cfg = loadConfig();
      const notifyOnExit = cfg.tools?.exec?.notifyOnExit !== false;
      if (!notifyOnExit) {
        return;
      }
      if (obj.suppressNotifyOnExit === true) {
        return;
      }

      const runId = normalizeOptionalString(obj.runId) ?? "";
      const command = sanitizeInboundSystemTags(normalizeOptionalString(obj.command) ?? "");
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = sanitizeInboundSystemTags(normalizeOptionalString(obj.output) ?? "");
      const reason = sanitizeInboundSystemTags(normalizeOptionalString(obj.reason) ?? "");

      let text = "";
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else if (evt.event === "exec.finished") {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        const compactOutput = compactExecEventOutput(output);
        const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
        if (!shouldNotify) {
          return;
        }
        if (
          runId &&
          shouldDropDuplicateExecFinished({
            sessionKey,
            runId,
            now: Date.now(),
          })
        ) {
          return;
        }
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (compactOutput) {
          text += `\n${compactOutput}`;
        }
      } else {
        text = `Exec denied (node=${nodeId}${runId ? ` id=${runId}` : ""}${reason ? `, ${reason}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      }

      const queued = enqueueSystemEvent(text, {
        sessionKey,
        contextKey: runId ? `exec:${runId}` : "exec",
        trusted: false,
      });
      if (queued) {
        // Scope wakes only for canonical agent sessions. Synthetic node-* fallback
        // keys should keep legacy unscoped behavior so enabled non-main heartbeat
        // agents still run when no explicit agent session is provided.
        requestHeartbeatNow(
          scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event", coalesceMs: 0 }),
        );
      }
      return;
    }
    case "push.apns.register": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return;
      }
      const transport = normalizeLowercaseStringOrEmpty(obj.transport) || "direct";
      const topic = typeof obj.topic === "string" ? obj.topic : "";
      const environment = obj.environment;
      try {
        if (transport === "relay") {
          const gatewayDeviceId = normalizeOptionalString(obj.gatewayDeviceId) ?? "";
          const currentGatewayDeviceId = loadOrCreateDeviceIdentity().deviceId;
          if (!gatewayDeviceId || gatewayDeviceId !== currentGatewayDeviceId) {
            ctx.logGateway.warn(
              `push relay register rejected node=${nodeId}: gateway identity mismatch`,
            );
            return;
          }
          await registerApnsRegistration({
            nodeId,
            transport: "relay",
            relayHandle: typeof obj.relayHandle === "string" ? obj.relayHandle : "",
            sendGrant: typeof obj.sendGrant === "string" ? obj.sendGrant : "",
            installationId: typeof obj.installationId === "string" ? obj.installationId : "",
            topic,
            environment,
            distribution: obj.distribution,
            tokenDebugSuffix: obj.tokenDebugSuffix,
          });
        } else {
          await registerApnsRegistration({
            nodeId,
            transport: "direct",
            token: typeof obj.token === "string" ? obj.token : "",
            topic,
            environment,
          });
        }
      } catch (err) {
        ctx.logGateway.warn(`push apns register failed node=${nodeId}: ${formatForLog(err)}`);
      }
      return;
    }
    default:
      return;
  }
};
