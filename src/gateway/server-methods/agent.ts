import { randomUUID } from "node:crypto";
import { agentCommand } from "../../commands/agent.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import {
  type AgentIdentityParams,
  type AgentWaitParams,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { waitForAgentJob } from "./agent-job.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentHandlers: GatewayRequestHandlers = {
  agent: async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
    if (!validateAgentParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      message: string;
      agentId?: string;
      to?: string;
      replyTo?: string;
      sessionId?: string;
      sessionKey?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      channel?: string;
      replyChannel?: string;
      accountId?: string;
      replyAccountId?: string;
      threadId?: string;
      lane?: string;
      extraSystemPrompt?: string;
      idempotencyKey: string;
      timeout?: number;
      label?: string;
      spawnedBy?: string;
    };
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`agent:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const normalizedAttachments =
      request.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
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

    let message = request.message.trim();
    let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        message = parsed.message.trim();
        images = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const isKnownGatewayChannel = (value: string): boolean => isGatewayMessageChannel(value);
    const channelHints = [request.channel, request.replyChannel]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const rawChannel of channelHints) {
      const normalized = normalizeMessageChannel(rawChannel);
      if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown channel: ${String(normalized)}`,
          ),
        );
        return;
      }
    }

    const agentIdRaw = typeof request.agentId === "string" ? request.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown agent id "${request.agentId}"`,
          ),
        );
        return;
      }
    }

    const requestedSessionKeyRaw =
      typeof request.sessionKey === "string" && request.sessionKey.trim()
        ? request.sessionKey.trim()
        : undefined;
    const requestedSessionKey =
      requestedSessionKeyRaw ??
      resolveExplicitAgentSessionKey({
        cfg,
        agentId,
      });
    if (agentId && requestedSessionKeyRaw) {
      const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
      if (sessionAgentId !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`,
          ),
        );
        return;
      }
    }
    let resolvedSessionId = request.sessionId?.trim() || undefined;
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = false;
    let cfgForAgent: ReturnType<typeof loadConfig> | undefined;

    if (requestedSessionKey) {
      const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const labelValue = request.label?.trim() || entry?.label;
      const spawnedByValue = request.spawnedBy?.trim() || entry?.spawnedBy;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      const nextEntry: SessionEntry = {
        sessionId,
        updatedAt: now,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        systemSent: entry?.systemSent,
        sendPolicy: entry?.sendPolicy,
        skillsSnapshot: entry?.skillsSnapshot,
        deliveryContext: deliveryFields.deliveryContext,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
        modelOverride: entry?.modelOverride,
        providerOverride: entry?.providerOverride,
        label: labelValue,
        spawnedBy: spawnedByValue,
      };
      sessionEntry = nextEntry;
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry,
        sessionKey: requestedSessionKey,
        channel: entry?.channel,
        chatType: entry?.chatType,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
        );
        return;
      }
      resolvedSessionId = sessionId;
      const canonicalSessionKey = canonicalKey;
      const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[canonicalSessionKey] = nextEntry;
        });
      }
      if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
        context.addChatRun(idem, {
          sessionKey: requestedSessionKey,
          clientRunId: idem,
        });
        bestEffortDeliver = true;
      }
      registerAgentRunContext(idem, { sessionKey: requestedSessionKey });
    }

    const runId = idem;

    const wantsDelivery = request.deliver === true;
    const explicitTo =
      typeof request.replyTo === "string" && request.replyTo.trim()
        ? request.replyTo.trim()
        : typeof request.to === "string" && request.to.trim()
          ? request.to.trim()
          : undefined;
    const explicitThreadId =
      typeof request.threadId === "string" && request.threadId.trim()
        ? request.threadId.trim()
        : undefined;
    const deliveryPlan = resolveAgentDeliveryPlan({
      sessionEntry,
      requestedChannel: request.replyChannel ?? request.channel,
      explicitTo,
      explicitThreadId,
      accountId: request.replyAccountId ?? request.accountId,
      wantsDelivery,
    });

    const resolvedChannel = deliveryPlan.resolvedChannel;
    const deliveryTargetMode = deliveryPlan.deliveryTargetMode;
    const resolvedAccountId = deliveryPlan.resolvedAccountId;
    let resolvedTo = deliveryPlan.resolvedTo;

    if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
      const cfgResolved = cfgForAgent ?? cfg;
      const fallback = resolveAgentOutboundTarget({
        cfg: cfgResolved,
        plan: deliveryPlan,
        targetMode: "implicit",
        validateExplicitTarget: false,
      });
      if (fallback.resolvedTarget?.ok) {
        resolvedTo = fallback.resolvedTo;
      }
    }

    const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

    const accepted = {
      runId,
      status: "accepted" as const,
      acceptedAt: Date.now(),
    };
    // Store an in-flight ack so retries do not spawn a second run.
    context.dedupe.set(`agent:${idem}`, {
      ts: Date.now(),
      ok: true,
      payload: accepted,
    });
    respond(true, accepted, undefined, { runId });

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;

    void agentCommand(
      {
        message,
        images,
        to: resolvedTo,
        sessionId: resolvedSessionId,
        sessionKey: requestedSessionKey,
        thinking: request.thinking,
        deliver,
        deliveryTargetMode,
        channel: resolvedChannel,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
        runContext: {
          messageChannel: resolvedChannel,
          accountId: resolvedAccountId,
          currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
        },
        timeout: request.timeout?.toString(),
        bestEffortDeliver,
        messageChannel: resolvedChannel,
        runId,
        lane: request.lane,
        extraSystemPrompt: request.extraSystemPrompt,
      },
      defaultRuntime,
      context.deps,
    )
      .then((result) => {
        const payload = {
          runId,
          status: "ok" as const,
          summary: "completed",
          result,
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        // Send a second res frame (same id) so TS clients with expectFinal can wait.
        // Swift clients will typically treat the first res as the result and ignore this.
        respond(true, payload, undefined, { runId });
      })
      .catch((err) => {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        const payload = {
          runId,
          status: "error" as const,
          summary: String(err),
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        });
        respond(false, payload, error, {
          runId,
          error: formatForLog(err),
        });
      });
  },
  "agent.identity.get": ({ params, respond }) => {
    if (!validateAgentIdentityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: ${formatValidationErrors(
            validateAgentIdentityParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as AgentIdentityParams;
    const agentIdRaw = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const sessionKeyRaw = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (sessionKeyRaw) {
      const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
      if (agentId && resolved !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
          ),
        );
        return;
      }
      agentId = resolved;
    }
    const cfg = loadConfig();
    const identity = resolveAssistantIdentity({ cfg, agentId });
    respond(true, identity, undefined);
  },
  "agent.wait": async ({ params, respond }) => {
    if (!validateAgentWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as AgentWaitParams;
    const runId = p.runId.trim();
    const timeoutMs =
      typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
        ? Math.max(0, Math.floor(p.timeoutMs))
        : 30_000;

    const snapshot = await waitForAgentJob({
      runId,
      timeoutMs,
    });
    if (!snapshot) {
      respond(true, {
        runId,
        status: "timeout",
      });
      return;
    }
    respond(true, {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
    });
  },
};
