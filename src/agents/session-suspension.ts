import path from "node:path";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { updateSessionStoreEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY = 1;
export const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

const laneResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export type SessionSuspensionReason = "quota_exhausted" | "manual" | "circuit_open";

function resolveLaneResumeConcurrency(cfg: OpenClawConfig | undefined, laneId: string): number {
  switch (laneId) {
    case "main":
      return resolveAgentMaxConcurrent(cfg);
    case "subagent":
      return resolveSubagentMaxConcurrent(cfg);
    case "cron":
    case "cron-nested": {
      const raw = cfg?.cron?.maxConcurrentRuns;
      return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
    }
    default:
      return DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY;
  }
}

export function resolveSessionSuspensionReason(reason: FailoverReason): SessionSuspensionReason {
  if (reason === "billing") {
    return "manual";
  }
  if (reason === "rate_limit") {
    return "quota_exhausted";
  }
  return "circuit_open";
}

function scheduleLaneAutoResume(laneId: string, delayMs: number, resumeConcurrency: number) {
  const existing = laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    laneResumeTimers.delete(laneId);
    setCommandLaneConcurrency(laneId, resumeConcurrency);
    log.info("auto-resumed lane after suspension TTL", {
      laneId,
      delayMs,
      resumeConcurrency,
    });
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  laneResumeTimers.set(laneId, timer);
}

export function cancelLaneAutoResume(laneId: string) {
  const existing = laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing);
    laneResumeTimers.delete(laneId);
  }
}

export async function suspendSession(params: {
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  sessionId: string;
  laneId?: string;
  reason: SessionSuspensionReason;
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
}) {
  if (!params.cfg) {
    return;
  }

  const { sessionKey, storePath } = resolveStoredSessionKeyForSessionId({
    cfg: params.cfg,
    sessionId: params.sessionId,
    agentId: params.agentDir ? path.basename(params.agentDir) : undefined,
  });

  if (!sessionKey) {
    return;
  }

  const ttlMs = params.ttlMs ?? DEFAULT_QUOTA_SUSPENSION_RESUME_MS;
  const now = Date.now();

  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now,
          reason: params.reason,
          failedProvider: params.failedProvider,
          failedModel: params.failedModel,
          summary: params.summary,
          laneId: params.laneId,
          expectedResumeBy: now + ttlMs,
          state: "suspended",
        },
      }),
    });
  } catch (err) {
    log.warn("failed to persist quota suspension; not throttling lane", {
      sessionId: params.sessionId,
      laneId: params.laneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (params.laneId) {
    setCommandLaneConcurrency(params.laneId, 0);
    scheduleLaneAutoResume(
      params.laneId,
      ttlMs,
      resolveLaneResumeConcurrency(params.cfg, params.laneId),
    );
  }
}

export const __testing = {
  resolveLaneResumeConcurrency,
  resolveSessionSuspensionReason,
} as const;
