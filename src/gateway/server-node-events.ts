// Gateway node event dispatcher.
// Handles device/node-originated events and routes them to sessions/channels.
import { randomUUID } from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { validateNodePresenceActivityPayload } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updatePairedDevicePresence, type NodePairingGeneration } from "../infra/device-pairing.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import {
  NODE_PRESENCE_ALIVE_EVENT,
  NODE_PRESENCE_ACTIVITY_EVENT,
  normalizeNodePresenceAliveReason,
} from "../shared/node-presence.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import {
  agentCommandFromIngress,
  ApnsRegistrationPairingChangedError,
  buildOutboundSessionContext,
  createOutboundSendDeps,
  defaultRuntime,
  deleteMediaBuffer,
  enqueueSystemEvent,
  formatForLog,
  getRuntimeConfig,
  loadOrCreateProcessDeviceIdentity,
  loadSessionEntry,
  normalizeChannelId,
  normalizeMainKey,
  normalizeRpcAttachmentsToChatAttachments,
  parseMessageWithAttachments,
  registerApnsRegistration,
  requestHeartbeat,
  resolveChatAttachmentMaxBytes,
  resolveGatewayModelSupportsImages,
  resolveOutboundTarget,
  resolveSessionAgentId,
  resolveSessionModelRef,
  persistInboundImagesForTranscript,
  sanitizeInboundSystemTags,
  sendDurableMessageBatch,
  canonicalizeSessionEntryAliases,
} from "./server-node-events.runtime.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;
const NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS = 60_000;
const MAX_RECENT_NODE_PRESENCE_KEYS = 1024;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
type VoiceTranscriptReservationAdmission = { work: Promise<unknown> } | null;
type VoiceTranscriptReservation = {
  fingerprint: string;
  receivedAt: number;
  status: "pending" | "ready" | "checking" | "rejected";
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  start?: () => Promise<unknown>;
  resolve: (admission: VoiceTranscriptReservationAdmission) => void;
  rejectDecision: (reason: unknown) => void;
  decision: Promise<VoiceTranscriptReservationAdmission>;
};
const pendingVoiceTranscriptReservations = new Map<string, VoiceTranscriptReservation[]>();
const recentExecFinishedRuns = new Map<string, number>();
const recentNodePresencePersistAt = new Map<string, number>();

type NodeEventHandleResult = {
  ok: true;
  event: string;
  handled: boolean;
  reason?: string;
};

type NodeAgentCommandInput = Parameters<typeof agentCommandFromIngress>[0];

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function dispatchNodeAgentCommand(
  ctx: NodeEventContext,
  nodeId: string,
  input: NodeAgentCommandInput,
  isConnectionCurrent?: () => boolean | Promise<boolean>,
  onAdmissionRejected?: () => void | Promise<void>,
): void {
  // The node RPC can finish before the agent starts its own session admission.
  // Reserve a root now so suspension cannot acknowledge and then strand the turn,
  // but recheck the admitted connection before agent work actually starts.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    if (isConnectionCurrent && !(await isConnectionCurrent())) {
      await onAdmissionRejected?.();
      return;
    }
    await agentCommandFromIngress(input, defaultRuntime, ctx.deps);
  }).catch((err: unknown) => {
    ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
  });
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
  // Voice providers can replay identical transcript fragments during reconnect.
  // Keep only a bounded last fingerprint per session to avoid duplicate sends.
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

function reserveVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  receivedAt: number;
}): {
  admit: (params: {
    isConnectionCurrent?: () => boolean | Promise<boolean>;
    start: () => Promise<unknown>;
  }) => Promise<VoiceTranscriptReservationAdmission>;
  reject: () => void;
} {
  // Resolve reservations in receipt order so delayed currentness checks cannot
  // change the dedupe window, while rejected connections leave no committed state.
  let resolveDecision: (admission: VoiceTranscriptReservationAdmission) => void = () => {};
  let rejectDecision: (reason: unknown) => void = () => {};
  const decision = new Promise<VoiceTranscriptReservationAdmission>((resolve, reject) => {
    resolveDecision = resolve;
    rejectDecision = reject;
  });
  const reservation: VoiceTranscriptReservation = {
    fingerprint: params.fingerprint,
    receivedAt: params.receivedAt,
    status: "pending",
    resolve: resolveDecision,
    rejectDecision,
    decision,
  };
  const queue = pendingVoiceTranscriptReservations.get(params.sessionKey) ?? [];
  queue.push(reservation);
  pendingVoiceTranscriptReservations.set(params.sessionKey, queue);

  const drain = () => {
    while (queue[0]?.status === "rejected") {
      const next = queue.shift();
      if (!next) {
        break;
      }
      next.resolve(null);
    }
    const next = queue[0];
    if (!next) {
      pendingVoiceTranscriptReservations.delete(params.sessionKey);
      return;
    }
    if (next.status !== "ready") {
      return;
    }
    next.status = "checking";
    void (async () => {
      try {
        const isCurrent = next.isConnectionCurrent ? await next.isConnectionCurrent() : true;
        const admission =
          isCurrent &&
          !shouldDropDuplicateVoiceTranscript({
            sessionKey: params.sessionKey,
            fingerprint: next.fingerprint,
            now: next.receivedAt,
          }) &&
          next.start
            ? { work: next.start() }
            : null;
        queue.shift();
        next.resolve(admission);
      } catch (err) {
        queue.shift();
        next.rejectDecision(err);
      }
      drain();
    })();
  };
  const settle = (status: "ready" | "rejected") => {
    if (reservation.status !== "pending") {
      return;
    }
    reservation.status = status;
    drain();
  };

  return {
    admit: ({ isConnectionCurrent, start }) => {
      reservation.isConnectionCurrent = isConnectionCurrent;
      reservation.start = start;
      settle("ready");
      return reservation.decision;
    },
    reject: () => settle("rejected"),
  };
}

function dispatchReservedVoiceAgentCommand(params: {
  ctx: NodeEventContext;
  nodeId: string;
  input: NodeAgentCommandInput;
  reservation: ReturnType<typeof reserveVoiceTranscript>;
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  onStart: () => void;
}): void {
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      params.reservation.reject();
      return;
    }
    const admission = await params.reservation.admit({
      isConnectionCurrent: params.isConnectionCurrent,
      start: () => {
        params.onStart();
        return agentCommandFromIngress(params.input, defaultRuntime, params.ctx.deps);
      },
    });
    if (!admission) {
      return;
    }
    await admission.work;
  }).catch((err: unknown) => {
    params.reservation.reject();
    params.ctx.logGateway.warn(`agent failed node=${params.nodeId}: ${formatForLog(err)}`);
  });
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

function pruneBoundedTimestampMap(
  map: Map<string, number>,
  params: { now: number; ttlMs: number; maxEntries: number },
) {
  if (map.size <= params.maxEntries) {
    return;
  }
  const cutoff = params.now - params.ttlMs;
  for (const [key, ts] of map) {
    if (ts < cutoff) {
      map.delete(key);
    }
    if (map.size <= params.maxEntries) {
      return;
    }
  }
  while (map.size > params.maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    map.delete(oldestKey);
  }
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
  return `${sliceUtf16Safe(normalized, 0, safe)}…`;
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
  return `${sliceUtf16Safe(normalized, 0, safe)}…`;
}

type LoadedSessionEntry = ReturnType<typeof loadSessionEntry>;

async function touchSessionStore(params: {
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  storeKeys: LoadedSessionEntry["storeKeys"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await canonicalizeSessionEntryAliases({
    storePath,
    target: {
      canonicalKey: params.canonicalKey,
      storeKeys: params.storeKeys,
    },
    update: (entry) => ({
      ...entry,
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
    }),
  });
}

function queueSessionStoreTouch(params: {
  ctx: NodeEventContext;
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  storeKeys: LoadedSessionEntry["storeKeys"];
  entry: LoadedSessionEntry["entry"];
  sessionId: string;
  now: number;
  isConnectionCurrent?: () => boolean | Promise<boolean>;
}) {
  // Voice dispatch intentionally does not wait for persistence, but a host
  // snapshot must not race the accepted write after its node RPC returns.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      return;
    }
    await touchSessionStore({
      storePath: params.storePath,
      canonicalKey: params.canonicalKey,
      storeKeys: params.storeKeys,
      entry: params.entry,
      sessionId: params.sessionId,
      now: params.now,
    });
  }).catch((err: unknown) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
  });
}

async function isNodeEventConnectionCurrent(opts?: {
  isConnectionCurrent?: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (!opts?.isConnectionCurrent) {
    return true;
  }
  try {
    return await opts.isConnectionCurrent();
  } catch {
    return false;
  }
}

function pairingChangedResult(event: string): NodeEventHandleResult {
  return { ok: true, event, handled: false, reason: "pairing_changed" };
}

async function cleanupNodeEventMedia(
  ids: Iterable<string>,
  ctx: Pick<NodeEventContext, "logGateway">,
): Promise<void> {
  for (const id of ids) {
    try {
      await deleteMediaBuffer(id);
    } catch (cleanupErr) {
      ctx.logGateway.warn(
        `Failed to cleanup orphaned media ${id}: ${formatErrorMessage(cleanupErr)}`,
      );
    }
  }
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
  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: params.channel,
    to: resolved.to,
    payloads: [{ text: params.text }],
    session,
    bestEffort: true,
    durability: "best_effort",
    deps: createOutboundSendDeps(params.deps),
  });
  if (send.status === "failed") {
    throw send.error;
  }
}

export const handleNodeEvent = async (
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: {
    connId?: string;
    deviceId?: string;
    pairingGeneration?: NodePairingGeneration;
    presenceAllowed?: boolean;
    isConnectionCurrent?: () => boolean | Promise<boolean>;
    resolveApnsRegistrationGeneration?: () => string | null | Promise<string | null>;
  },
): Promise<NodeEventHandleResult | undefined> => {
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  switch (evt.event) {
    case "voice.transcript": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const text = normalizeOptionalString(obj.text) ?? "";
      if (!text) {
        return undefined;
      }
      if (text.length > 20_000) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
      const cfg = getRuntimeConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey, storeKeys } = loadSessionEntry(sessionKey);
      if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
        return undefined;
      }
      const receivedAt = Date.now();
      const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
      const sessionId = entry?.sessionId ?? randomUUID();
      const runId = randomUUID();
      const transcriptReservation = reserveVoiceTranscript({
        sessionKey: canonicalKey,
        fingerprint,
        receivedAt,
      });

      dispatchReservedVoiceAgentCommand({
        ctx,
        nodeId,
        input: {
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
          allowModelOverride: false,
        },
        reservation: transcriptReservation,
        isConnectionCurrent: opts?.isConnectionCurrent,
        onStart: () => {
          queueSessionStoreTouch({
            ctx,
            storePath,
            canonicalKey,
            storeKeys,
            entry,
            sessionId,
            now: receivedAt,
            isConnectionCurrent: opts?.isConnectionCurrent,
          });

          // Ensure chat UI clients refresh when this run completes (even though it wasn't started via chat.send).
          // This maps agent bus events (keyed by per-turn runId) to chat events (keyed by clientRunId).
          ctx.addChatRun(runId, {
            sessionKey: canonicalKey,
            clientRunId: `voice-${randomUUID()}`,
          });
        },
      });
      return undefined;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return undefined;
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

      let link: AgentDeepLink | null;
      try {
        link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
      } catch {
        return undefined;
      }

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
      const cfg = getRuntimeConfig();
      const { storePath, entry, canonicalKey, storeKeys } = loadSessionEntry(sessionKey);
      if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
        return undefined;
      }

      let message = (link?.message ?? "").trim();
      const transcriptMessage = message;
      const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
        link?.attachments ?? undefined,
      );
      let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      let imageOrder: PromptImageOrderEntry[] = [];
      let offloadedRefs: Awaited<ReturnType<typeof parseMessageWithAttachments>>["offloadedRefs"] =
        [];
      if (!message && normalizedAttachments.length === 0) {
        return undefined;
      }
      if (message.length > 20_000) {
        return undefined;
      }
      if (normalizedAttachments.length > 0) {
        const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
        const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
        const supportsInlineImages = await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
          provider: modelRef.provider,
          model: modelRef.model,
        });
        if (!(await isNodeEventConnectionCurrent(opts))) {
          return pairingChangedResult(evt.event);
        }
        try {
          const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: ctx.logGateway,
            supportsInlineImages,
            // server-node-events dispatches via agentCommandFromIngress which
            // has no ctx.MediaPaths wiring; reject non-image attachments
            // explicitly rather than saving them where the agent cannot reach them.
            acceptNonImage: false,
          });
          if (!(await isNodeEventConnectionCurrent(opts))) {
            await cleanupNodeEventMedia(
              (parsed.offloadedRefs ?? []).map((ref) => ref.id),
              ctx,
            );
            return pairingChangedResult(evt.event);
          }
          message = parsed.message.trim();
          images = parsed.images;
          imageOrder = parsed.imageOrder;
          offloadedRefs = parsed.offloadedRefs;
          if (message.length > 20_000) {
            ctx.logGateway.warn(
              `agent.request message exceeds limit after attachment parsing (length=${message.length})`,
            );
            if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) {
              await cleanupNodeEventMedia(
                parsed.offloadedRefs.map((ref) => ref.id),
                ctx,
              );
            }
            return undefined;
          }
        } catch (err) {
          ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(err)}`);
          return undefined;
        }
      }

      if (!message && images.length === 0) {
        return undefined;
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
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(
          (offloadedRefs ?? []).map((ref) => ref.id),
          ctx,
        );
        return pairingChangedResult(evt.event);
      }
      await touchSessionStore({
        storePath,
        canonicalKey,
        storeKeys,
        entry,
        sessionId,
        now,
      });
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(
          (offloadedRefs ?? []).map((ref) => ref.id),
          ctx,
        );
        return pairingChangedResult(evt.event);
      }

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

      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(
          (offloadedRefs ?? []).map((ref) => ref.id),
          ctx,
        );
        return pairingChangedResult(evt.event);
      }
      const persistedTranscriptMedia = await persistInboundImagesForTranscript({
        images,
        imageOrder,
        offloadedRefs,
        log: ctx.logGateway,
        logContext: "agent.request",
      });
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(
          persistedTranscriptMedia.map((media) => media.id),
          ctx,
        );
        return pairingChangedResult(evt.event);
      }
      const transcriptMedia = persistedTranscriptMedia.map((media) => ({
        path: media.path,
        contentType: media.contentType,
      }));

      if (wantsReceipt && deliveryChannel && deliveryTo) {
        // Delivery stays detached from agent startup, but remains part of the
        // accepted node request until the durable send settles.
        void runWithGatewayIndependentRootWorkContinuation(async () => {
          if (!(await isNodeEventConnectionCurrent(opts))) {
            return;
          }
          await sendReceiptAck({
            cfg,
            deps: ctx.deps,
            sessionKey: canonicalKey,
            channel: deliveryChannel,
            to: deliveryTo,
            text: receiptText,
          });
        }).catch((err: unknown) => {
          ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(err)}`);
        });
      } else if (wantsReceipt) {
        ctx.logGateway.warn(
          `agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`,
        );
      }

      dispatchNodeAgentCommand(
        ctx,
        nodeId,
        {
          runId: sessionId,
          message,
          images,
          imageOrder,
          ...(transcriptMedia.length > 0 ? { transcriptMessage, transcriptMedia } : {}),
          sessionId,
          sessionKey: canonicalKey,
          thinking: link?.thinking ?? undefined,
          deliver,
          to: deliveryTo,
          channel: deliveryChannel,
          timeout:
            typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
          messageChannel: "node",
          allowModelOverride: false,
        },
        opts?.isConnectionCurrent,
        () =>
          cleanupNodeEventMedia(
            persistedTranscriptMedia.map((media) => media.id),
            ctx,
          ),
      );
      return undefined;
    }
    case "notifications.changed": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const change = normalizeOptionalString(obj.change)
        ? normalizeLowercaseStringOrEmpty(obj.change)
        : undefined;
      if (change !== "posted" && change !== "removed") {
        return undefined;
      }
      const keyRaw = normalizeOptionalString(obj.key);
      if (!keyRaw) {
        return undefined;
      }
      const key = sanitizeInboundSystemTags(keyRaw);
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      const { canonicalKey: sessionKey, entry } = loadSessionEntry(sessionKeyRaw);
      if (resolveAgentHarnessSessionContextError(sessionKey, entry)) {
        return undefined;
      }
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
      });
      if (queued) {
        requestHeartbeat({
          source: "notifications-event",
          intent: "event",
          reason: "notifications-event",
          sessionKey,
        });
      }
      return undefined;
    }
    case "chat.subscribe": {
      if (!evt.payloadJSON) {
        return undefined;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return undefined;
      }
      await ctx.nodeSubscribe(nodeId, sessionKey, opts?.connId);
      return undefined;
    }
    case "chat.unsubscribe": {
      if (!evt.payloadJSON) {
        return undefined;
      }
      const sessionKey = parseSessionKeyFromPayloadJSON(evt.payloadJSON);
      if (!sessionKey) {
        return undefined;
      }
      await ctx.nodeUnsubscribe(nodeId, sessionKey, opts?.connId);
      return undefined;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      if (!sessionKeyRaw) {
        return undefined;
      }
      const { canonicalKey: sessionKey } = loadSessionEntry(sessionKeyRaw);

      const cfg = getRuntimeConfig();
      const runId = normalizeOptionalString(obj.runId) ?? "";
      if (
        !ctx.authorizeNodeSystemRunEvent({
          nodeId,
          connId: opts?.connId,
          ...(runId ? { runId } : {}),
          // Match the key sent in system.run params; canonicalization below is for routing.
          sessionKey: sessionKeyRaw,
          terminal: evt.event === "exec.finished" || evt.event === "exec.denied",
        })
      ) {
        return {
          ok: true,
          event: evt.event,
          handled: false,
          reason: "unmatched_exec_event",
        };
      }
      // Respect tools.exec.notifyOnExit setting (default: true)
      // When false, skip system event notifications for node exec events.
      const notifyOnExit = cfg.tools?.exec?.notifyOnExit !== false;
      if (!notifyOnExit) {
        return undefined;
      }
      if (obj.suppressNotifyOnExit === true) {
        return undefined;
      }
      if (evt.event === "exec.denied") {
        return undefined;
      }
      const command = sanitizeInboundSystemTags(normalizeOptionalString(obj.command) ?? "");
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = sanitizeInboundSystemTags(normalizeOptionalString(obj.output) ?? "");
      // Strip parens from the untrusted RAW reason before sanitizeInboundSystemTags
      // runs: the `Exec denied (node=..., <reason>): cmd` wire format is parsed by
      // matching the first balanced `(...)` and stray parens in user-supplied
      // input would break the metadata/body boundary. We strip pre-sanitize so
      // that legitimate `[System Message]` style tags can still be converted to
      // `(System Message)` by sanitizeInboundSystemTags afterward.
      const reason = sanitizeInboundSystemTags(
        (normalizeOptionalString(obj.reason) ?? "").replace(/[()]/g, ""),
      );

      let text;
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
          return undefined;
        }
        if (
          runId &&
          shouldDropDuplicateExecFinished({
            sessionKey,
            runId,
            now: Date.now(),
          })
        ) {
          return undefined;
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

      const eventRouting = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
      const queued = enqueueSystemEvent(text, {
        sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
        contextKey: runId ? `exec:${runId}` : "exec",
      });
      if (queued) {
        // Scope wakes only for canonical agent sessions. Synthetic node-* fallback
        // keys should keep legacy unscoped behavior so enabled non-main heartbeat
        // agents still run when no explicit agent session is provided.
        requestHeartbeat(
          scopedHeartbeatWakeOptionsForPolicy(
            sessionKey,
            {
              source: "exec-event",
              intent: "event",
              reason: "exec-event",
              coalesceMs: 0,
            },
            eventRouting,
          ),
        );
      }
      return undefined;
    }
    case "push.apns.register": {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const transport = normalizeLowercaseStringOrEmpty(obj.transport) || "direct";
      const topic = typeof obj.topic === "string" ? obj.topic : "";
      const environment = obj.environment;
      try {
        const expectedPairingGeneration = await opts?.resolveApnsRegistrationGeneration?.();
        if (!expectedPairingGeneration) {
          ctx.logGateway.warn(
            `push apns register rejected node=${nodeId}: stale or invalidated pairing session`,
          );
          return pairingChangedResult(evt.event);
        }
        if (transport === "relay") {
          const gatewayDeviceId = normalizeOptionalString(obj.gatewayDeviceId) ?? "";
          const currentGatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
          if (!gatewayDeviceId || gatewayDeviceId !== currentGatewayDeviceId) {
            ctx.logGateway.warn(
              `push relay register rejected node=${nodeId}: gateway identity mismatch`,
            );
            return undefined;
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
            relayOrigin: obj.relayOrigin,
            tokenDebugSuffix: obj.tokenDebugSuffix,
            expectedPairingGeneration,
          });
        } else {
          await registerApnsRegistration({
            nodeId,
            transport: "direct",
            token: typeof obj.token === "string" ? obj.token : "",
            topic,
            environment,
            expectedPairingGeneration,
          });
        }
      } catch (err) {
        if (err instanceof ApnsRegistrationPairingChangedError) {
          ctx.logGateway.warn(
            `push apns register rejected node=${nodeId}: stale or invalidated pairing session`,
          );
          return pairingChangedResult(evt.event);
        }
        ctx.logGateway.warn(`push apns register failed node=${nodeId}: ${formatForLog(err)}`);
      }
      return undefined;
    }
    case NODE_PRESENCE_ACTIVITY_EVENT: {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj || !validateNodePresenceActivityPayload(obj)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      if ("action" in obj) {
        const cleared = ctx.clearNodePresenceActivity?.({ nodeId, connId: opts?.connId });
        if (cleared === null || cleared === undefined) {
          return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
        }
        if (cleared) {
          ctx.broadcast(
            "node.presence",
            { nodeId, lastActiveAtMs: null, presenceUpdatedAtMs: null },
            { dropIfSlow: true },
          );
        }
        return {
          ok: true,
          event: evt.event,
          handled: true,
          reason: cleared ? "cleared" : "already_clear",
        };
      }
      if (opts?.presenceAllowed !== true) {
        return { ok: true, event: evt.event, handled: false, reason: "permission_required" };
      }
      const updated = ctx.updateNodePresenceActivity?.({
        nodeId,
        connId: opts.connId,
        idleSeconds: obj.idleSeconds,
        ...(obj.saturated === true ? { saturated: true } : {}),
      });
      if (!updated) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      ctx.broadcast("node.presence", { nodeId, ...updated }, { dropIfSlow: true });
      return { ok: true, event: evt.event, handled: true, reason: "updated" };
    }
    case NODE_PRESENCE_ALIVE_EVENT: {
      const obj = parsePayloadObject(evt.payloadJSON);
      if (!obj) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const deviceId = normalizeOptionalString(opts?.deviceId);
      if (!deviceId) {
        return { ok: true, event: evt.event, handled: false, reason: "missing_device_identity" };
      }
      const pairingGeneration = opts?.pairingGeneration;
      if (!pairingGeneration || pairingGeneration.nodeId !== deviceId) {
        return pairingChangedResult(evt.event);
      }
      const now = Date.now();
      const presenceOwnerKey = `${deviceId}\0${pairingGeneration.key}`;
      const lastPersistedAt = recentNodePresencePersistAt.get(presenceOwnerKey) ?? 0;
      if (now - lastPersistedAt < NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS) {
        return { ok: true, event: evt.event, handled: true, reason: "throttled" };
      }

      const lastSeenReason = normalizeNodePresenceAliveReason(obj.trigger);
      try {
        // Node last-seen lives on the device record; node.pair.list projects
        // it from there, so one write covers both surfaces.
        const deviceUpdated = await updatePairedDevicePresence(
          deviceId,
          {
            lastSeenAtMs: now,
            lastSeenReason,
          },
          pairingGeneration,
        );
        if (!deviceUpdated) {
          return pairingChangedResult(evt.event);
        }
        recentNodePresencePersistAt.set(presenceOwnerKey, now);
        pruneBoundedTimestampMap(recentNodePresencePersistAt, {
          now,
          ttlMs: NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS * 10,
          maxEntries: MAX_RECENT_NODE_PRESENCE_KEYS,
        });
        return { ok: true, event: evt.event, handled: true, reason: "persisted" };
      } catch (err) {
        ctx.logGateway.warn(`node presence alive failed node=${nodeId}: ${formatForLog(err)}`);
        return { ok: true, event: evt.event, handled: false, reason: "persist_failed" };
      }
    }
    default:
      return undefined;
  }
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
