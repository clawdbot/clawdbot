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
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeMessageProvider } from "../../utils/message-provider.js";
import { normalizeE164 } from "../../utils.js";
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
    const message = request.message.trim();

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
      const rawMainKey = (cfg.session?.mainKey ?? "main").trim() || "main";
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

    const resolvedProvider = (() => {
      if (requestedProvider === "last") {
        // WebChat is not a deliverable surface. Treat it as "unset" for routing,
        // so VoiceWake and CLI callers don't get stuck with deliver=false.
        return lastProvider && lastProvider !== "webchat"
          ? lastProvider
          : "whatsapp";
      }
      if (
        requestedProvider === "whatsapp" ||
        requestedProvider === "telegram" ||
        requestedProvider === "discord" ||
        requestedProvider === "signal" ||
        requestedProvider === "imessage" ||
        requestedProvider === "webchat"
      ) {
        return requestedProvider;
      }
      return lastProvider && lastProvider !== "webchat"
        ? lastProvider
        : "whatsapp";
    })();

    const resolvedTo = (() => {
      const explicit =
        typeof request.to === "string" && request.to.trim()
          ? request.to.trim()
          : undefined;
      if (explicit) return explicit;
      if (
        resolvedProvider === "whatsapp" ||
        resolvedProvider === "telegram" ||
        resolvedProvider === "discord" ||
        resolvedProvider === "signal" ||
        resolvedProvider === "imessage"
      ) {
        return lastTo || undefined;
      }
      return undefined;
    })();

    const sanitizedTo = (() => {
      // If we derived a WhatsApp recipient from session "lastTo", ensure it is still valid
      // for the configured allowlist. Otherwise, fall back to the first allowed number so
      // voice wake doesn't silently route to stale/test recipients.
      if (resolvedProvider !== "whatsapp") return resolvedTo;
      const explicit =
        typeof request.to === "string" && request.to.trim()
          ? request.to.trim()
          : undefined;
      if (explicit) return resolvedTo;

      const cfg = cfgForAgent ?? loadConfig();
      const rawAllow = cfg.whatsapp?.allowFrom ?? [];
      if (rawAllow.includes("*")) return resolvedTo;
      const allowFrom = rawAllow
        .map((val) => normalizeE164(val))
        .filter((val) => val.length > 1);
      if (allowFrom.length === 0) return resolvedTo;

      const normalizedLast =
        typeof resolvedTo === "string" && resolvedTo.trim()
          ? normalizeE164(resolvedTo)
          : undefined;
      if (normalizedLast && allowFrom.includes(normalizedLast)) {
        return normalizedLast;
      }
      return allowFrom[0];
    })();

    const deliver = request.deliver === true && resolvedProvider !== "webchat";

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
        to: sanitizedTo,
        sessionId: resolvedSessionId,
        sessionKey: requestedSessionKey,
        thinking: request.thinking,
        deliver,
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
