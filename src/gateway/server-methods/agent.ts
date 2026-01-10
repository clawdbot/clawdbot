import { randomUUID } from "node:crypto";

import { agentCommand } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { DEFAULT_CHAT_PROVIDER } from "../../providers/registry.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  INTERNAL_MESSAGE_PROVIDER,
  isDeliverableMessageProvider,
  isGatewayMessageProvider,
  normalizeMessageProvider,
} from "../../utils/message-provider.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import {
  type AgentWaitParams,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
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
      to?: string;
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
      provider?: string;
      lane?: string;
      extraSystemPrompt?: string;
      idempotencyKey: string;
      timeout?: number;
      label?: string;
      spawnedBy?: string;
    };
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
        const parsed = await parseMessageWithAttachments(
          message,
          normalizedAttachments,
          { maxBytes: 5_000_000, log: context.logGateway },
        );
        message = parsed.message.trim();
        images = parsed.images;
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, String(err)),
        );
        return;
      }
    }
    const rawProvider =
      typeof request.provider === "string" ? request.provider.trim() : "";
    if (rawProvider) {
      const normalized = normalizeMessageProvider(rawProvider);
      if (
        normalized &&
        normalized !== "last" &&
        !isGatewayMessageProvider(normalized)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown provider: ${normalized}`,
          ),
        );
        return;
      }
    }

    const requestedSessionKey =
      typeof request.sessionKey === "string" && request.sessionKey.trim()
        ? request.sessionKey.trim()
        : undefined;
    let resolvedSessionId = request.sessionId?.trim() || undefined;
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = false;
    let cfgForAgent: ReturnType<typeof loadConfig> | undefined;

    if (requestedSessionKey) {
      const { cfg, storePath, store, entry } =
        loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const labelValue = request.label?.trim() || entry?.label;
      const spawnedByValue = request.spawnedBy?.trim() || entry?.spawnedBy;
      const nextEntry: SessionEntry = {
        sessionId,
        updatedAt: now,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        systemSent: entry?.systemSent,
        sendPolicy: entry?.sendPolicy,
        skillsSnapshot: entry?.skillsSnapshot,
        lastProvider: entry?.lastProvider,
        lastTo: entry?.lastTo,
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
        provider: entry?.provider,
        chatType: entry?.chatType,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "send blocked by session policy",
          ),
        );
        return;
      }
      if (store) {
        store[requestedSessionKey] = nextEntry;
        if (storePath) {
          await saveSessionStore(storePath, store);
        }
      }
      resolvedSessionId = sessionId;
      const agentId = resolveAgentIdFromSessionKey(requestedSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({
        cfg,
        agentId,
      });
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      if (
        requestedSessionKey === mainSessionKey ||
        requestedSessionKey === rawMainKey
      ) {
        context.addChatRun(idem, {
          sessionKey: requestedSessionKey,
          clientRunId: idem,
        });
        bestEffortDeliver = true;
      }
      registerAgentRunContext(idem, { sessionKey: requestedSessionKey });
    }

    const runId = idem;

    const requestedProvider =
      normalizeMessageProvider(request.provider) ?? "last";

    const lastProvider = sessionEntry?.lastProvider;
    const lastTo =
      typeof sessionEntry?.lastTo === "string"
        ? sessionEntry.lastTo.trim()
        : "";

    const wantsDelivery = request.deliver === true;

    const resolvedProvider = (() => {
      if (requestedProvider === "last") {
        // WebChat is not a deliverable surface. Treat it as "unset" for routing,
        // so VoiceWake and CLI callers don't get stuck with deliver=false.
        if (lastProvider && lastProvider !== INTERNAL_MESSAGE_PROVIDER) {
          return lastProvider;
        }
        return wantsDelivery
          ? DEFAULT_CHAT_PROVIDER
          : INTERNAL_MESSAGE_PROVIDER;
      }

      if (isGatewayMessageProvider(requestedProvider)) return requestedProvider;

      if (lastProvider && lastProvider !== INTERNAL_MESSAGE_PROVIDER) {
        return lastProvider;
      }
      return wantsDelivery ? DEFAULT_CHAT_PROVIDER : INTERNAL_MESSAGE_PROVIDER;
    })();

    const explicitTo =
      typeof request.to === "string" && request.to.trim()
        ? request.to.trim()
        : undefined;
    const deliveryTargetMode = explicitTo
      ? "explicit"
      : isDeliverableMessageProvider(resolvedProvider)
        ? "implicit"
        : undefined;
    let resolvedTo =
      explicitTo ||
      (isDeliverableMessageProvider(resolvedProvider)
        ? lastTo || undefined
        : undefined);
    if (
      !resolvedTo &&
      isDeliverableMessageProvider(resolvedProvider) &&
      resolvedProvider !== INTERNAL_MESSAGE_PROVIDER
    ) {
      const cfg = cfgForAgent ?? loadConfig();
      const fallback = resolveOutboundTarget({
        provider: resolvedProvider,
        cfg,
        accountId: sessionEntry?.lastAccountId ?? undefined,
        mode: "implicit",
      });
      if (fallback.ok) {
        resolvedTo = fallback.to;
      }
    }

    const deliver =
      request.deliver === true &&
      resolvedProvider !== INTERNAL_MESSAGE_PROVIDER;

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
        provider: resolvedProvider,
        timeout: request.timeout?.toString(),
        bestEffortDeliver,
        messageProvider: resolvedProvider,
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
