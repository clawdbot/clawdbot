// Runs heartbeat checks and emits status updates for configured agents.
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { HeartbeatRunOptions } from "./heartbeat-runner-execution.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";
import { runHeartbeatOnceCore as runSplitHeartbeatOnce } from "./heartbeat-runner-run.js";
import {
  startHeartbeatRunnerScheduled as startSplitHeartbeatRunner,
  type HeartbeatRunner,
} from "./heartbeat-runner-scheduler.js";
import {
  inferHeartbeatWakeSourceFromReason,
  resolveHeartbeatContinuationTrigger,
  resolveHeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";
import {
  getActiveHeartbeatWakeContext,
  hasTrustedContinuationHeartbeatWake,
} from "./heartbeat-wake.js";

export type { HeartbeatDeps } from "./heartbeat-runner-execution.js";
export {
  resolveHeartbeatAgents,
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatSchedulerSeed,
} from "./heartbeat-runner-config.js";
export type { HeartbeatRunner } from "./heartbeat-runner-scheduler.js";
export { resolveHeartbeatSession } from "./heartbeat-runner-session.js";
export { isCronSystemEvent } from "./heartbeat-events-filter.js";
export {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "./heartbeat-summary.js";
export { areHeartbeatsEnabled, setHeartbeatsEnabled } from "./heartbeat-wake.js";

type ContinuationHeartbeatRunOptions = HeartbeatRunOptions & {
  parentRunId?: string;
  trustedContinuationRouting?: boolean;
};

export async function runHeartbeatOnce(
  opts: ContinuationHeartbeatRunOptions,
): ReturnType<typeof runSplitHeartbeatOnce> {
  const continuationTrigger = resolveHeartbeatContinuationTrigger(opts.reason);
  const trustedContinuationRouting =
    opts.trustedContinuationRouting === true || hasTrustedContinuationHeartbeatWake(opts);
  const requestedSessionKey = opts.sessionKey?.trim();
  const requestedSession = requestedSessionKey
    ? parseAgentSessionKey(requestedSessionKey)
    : undefined;
  const resolvedAgentId = normalizeAgentId(opts.agentId ?? requestedSession?.agentId ?? "");
  // Trusted continuation returns are the sole subagent-routing exception.
  // Keep preflight guarded, but execute the reply against the same-agent target session.
  const trustedTargetSessionKey =
    trustedContinuationRouting &&
    continuationTrigger &&
    requestedSessionKey &&
    requestedSession &&
    isSubagentSessionKey(requestedSessionKey) &&
    normalizeAgentId(requestedSession.agentId) === resolvedAgentId
      ? requestedSessionKey
      : undefined;
  if (!continuationTrigger && !opts.parentRunId && !trustedTargetSessionKey) {
    return await runSplitHeartbeatOnce(opts);
  }
  const getReplyFromConfig =
    opts.deps?.getReplyFromConfig ??
    (await import("./heartbeat-runner.runtime.js")).getReplyFromConfig;
  return await runSplitHeartbeatOnce({
    ...opts,
    deps: {
      ...opts.deps,
      getReplyFromConfig: (ctx, replyOpts, cfg) =>
        getReplyFromConfig(
          trustedTargetSessionKey ? { ...ctx, SessionKey: trustedTargetSessionKey } : ctx,
          {
            ...replyOpts,
            ...(continuationTrigger ? { continuationTrigger } : {}),
            ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
          },
          cfg,
        ),
    },
  });
}

type StartHeartbeatRunnerOptions = Omit<
  Parameters<typeof startSplitHeartbeatRunner>[0],
  "runOnce"
> & {
  runOnce?: (opts: ContinuationHeartbeatRunOptions) => ReturnType<typeof runSplitHeartbeatOnce>;
};

export function startHeartbeatRunner(opts: StartHeartbeatRunnerOptions): HeartbeatRunner {
  const { runOnce: requestedRunOnce, ...rest } = opts;
  const runOnce = requestedRunOnce ?? runHeartbeatOnce;
  return startSplitHeartbeatRunner({
    ...rest,
    runOnce: (runOpts) => {
      const wake = getActiveHeartbeatWakeContext();
      const isTargetedWake = Boolean(
        wake?.sessionKey && runOpts.sessionKey && wake.sessionKey === runOpts.sessionKey,
      );
      return runOnce({
        ...runOpts,
        ...(isTargetedWake && wake?.parentRunId ? { parentRunId: wake.parentRunId } : {}),
        ...(isTargetedWake && hasTrustedContinuationHeartbeatWake(wake)
          ? { trustedContinuationRouting: true }
          : {}),
      });
    },
  });
}

export const testing = {
  inferHeartbeatWakeSourceFromReason,
  resolveHeartbeatWakePayloadFlags,
  truncateHeartbeatPreview,
};
