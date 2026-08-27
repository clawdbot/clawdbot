/** Manual cron wake helper for queueing system events into sessions. */
import type { HeartbeatWakeRequest } from "../../infra/heartbeat-wake.js";
import {
  isSubagentSessionKey,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveCronDeliverySessionKey } from "../session-target.js";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

export function enqueueCronSystemEvent(
  state: CronServiceState,
  text: string,
  opts?: Parameters<CronServiceState["deps"]["enqueueSystemEvent"]>[1],
) {
  return state.deps.enqueueSystemEvent(text, opts);
}

export function requestCronHeartbeat(
  state: CronServiceState,
  opts: Omit<HeartbeatWakeRequest, "source"> & { source?: HeartbeatWakeRequest["source"] },
) {
  state.deps.requestHeartbeat({ source: "cron", ...opts });
}

/** Keeps safety notices with their creator and limits failure routes to explicit origins. */
export function enqueueCronNotification(
  state: CronServiceState,
  job: CronJob,
  text: string,
  kind: "auto-disabled" | "failure-alert",
): void {
  const sessionKey = kind === "failure-alert" ? resolveCronDeliverySessionKey(job) : job.sessionKey;
  const agentId =
    normalizeOptionalAgentId(job.agentId) ??
    normalizeOptionalAgentId(parseAgentSessionKey(sessionKey)?.agentId) ??
    normalizeOptionalAgentId(state.deps.resolveDefaultAgentId?.()) ??
    normalizeOptionalAgentId(state.deps.defaultAgentId);
  const deliveryContext =
    sessionKey || (kind === "auto-disabled" && agentId)
      ? state.deps.resolveOriginDeliveryContext?.({ agentId, sessionKey })
      : undefined;
  enqueueCronSystemEvent(state, text, {
    agentId,
    sessionKey,
    contextKey: `cron:${job.id}:${kind}`,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  if (kind === "auto-disabled" || job.wakeMode === "now" || sessionKey) {
    requestCronHeartbeat(state, {
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId,
      sessionKey,
    });
  }
}

/** Enqueues a manual cron wake event and optionally pokes the targeted heartbeat loop. */
export function wake(
  state: CronServiceState,
  opts: {
    mode: "now" | "next-heartbeat";
    text: string;
    /**
     * Internal session key to enqueue the system event against. When omitted,
     * the dep resolves the configured system-agent target — wakes from a non-main
     * session would otherwise route to the wrong place. Callers wiring an
     * agent-tool `wake` should thread the resolved session key (e.g. from
     * `cron-tool`'s `resolveInternalSessionKey`) so the event lands on the
     * originating conversation lane.
     */
    sessionKey?: string;
    /**
     * Agent id paired with `sessionKey`. Forwarded to `enqueueSystemEvent`
     * and the heartbeat request so multi-agent setups route to the agent
     * that owns the targeted session — fixes the related half of #46886
     * ("always routes to default agent").
     */
    agentId?: string;
  },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  const agentId = opts.agentId?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  // Carry the originating session's channel-correct delivery context (e.g. the
  // bound Telegram topic/thread) so a wake routes back into that thread instead
  // of the chat root. Only attempt this when an origin session is targeted; a
  // A no-origin wake keeps the empty option shape so the Gateway adapter can
  // resolve the current system-agent owner and session atomically.
  const originDeliveryContext =
    sessionKey || agentId
      ? state.deps.resolveOriginDeliveryContext?.({ sessionKey, agentId })
      : undefined;
  const enqueueOpts =
    sessionKey || agentId
      ? {
          ...(sessionKey ? { sessionKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(originDeliveryContext ? { deliveryContext: originDeliveryContext } : {}),
        }
      : undefined;
  enqueueCronSystemEvent(state, text, enqueueOpts);
  if (opts.mode === "now" || sessionKey) {
    // Scheduled heartbeats only inspect the agent's main session, so a targeted
    // next-heartbeat event needs an immediate wake to avoid being stranded.
    requestCronHeartbeat(state, {
      source: "manual",
      intent: "immediate",
      reason: "wake",
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
    });
  }
  return { ok: true } as const;
}
