import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { BullMQCronService } from "../cron/bullmq/index.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayCronState = {
  cron: CronService | BullMQCronService;
  storePath: string;
  cronEnabled: boolean;
};

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.CLAWDBOT_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  // Use BullMQ backend by default, or fall back to setTimeout-based if disabled
  const useBullMQ = process.env.CLAWDBOT_CRON_BACKEND !== "timer";
  const redisUrl = process.env.REDIS_URL || params.cfg.cron?.redisUrl;

  // BullMQ queue configuration
  const queueConfig = {
    workerConcurrency: params.cfg.cron?.workerConcurrency,
    jobRetryAttempts: params.cfg.cron?.jobRetryAttempts,
    jobRetryDelayMs: params.cfg.cron?.jobRetryDelayMs,
    stalledIntervalMs: params.cfg.cron?.stalledIntervalMs,
    maxStalledCount: params.cfg.cron?.maxStalledCount,
    completedJobsRetention: params.cfg.cron?.completedJobsRetention,
    failedJobsRetention: params.cfg.cron?.failedJobsRetention,
  };

  const cronDeps = {
    storePath,
    cronEnabled,
    redisUrl,
    queueConfig,
    enqueueSystemEvent: (text: string, opts?: { agentId?: string }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveAgentMainSessionKey({
        cfg: runtimeConfig,
        agentId,
      });
      enqueueSystemEvent(text, { sessionKey });
    },
    requestHeartbeatNow,
    runHeartbeatOnce: async (opts?: { reason?: string }) => {
      const runtimeConfig = loadConfig();
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({
      job,
      message,
    }: {
      job: { id: string; agentId?: string };
      message: string;
    }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job: job as any,
        message,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt: any) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (!useBullMQ && evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          outputText: evt.outputText,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  };

  const cron = useBullMQ ? new BullMQCronService(cronDeps) : new CronService(cronDeps);

  return { cron, storePath, cronEnabled };
}
