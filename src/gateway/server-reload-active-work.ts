import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getInspectableActiveTaskRestartBlockers } from "../tasks/task-registry.maintenance.js";
import { formatActiveTaskRestartBlocker } from "../tasks/task-restart-blocker.js";
import type { ChannelKind } from "./config-reload-plan.js";
import {
  isGatewayReloadGenerationAborted,
  type GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";

const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 30_000;

export function createGatewayActiveWorkTracker(options: {
  params: GatewayReloadHandlerParams;
  myGeneration: number;
}) {
  const { params, myGeneration } = options;
  const getActiveCounts = () => {
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const embeddedRuns = getActiveEmbeddedRunCount();
    const backgroundExecSessions = getActiveBackgroundExecSessionCount();
    const rootRequests = getActiveGatewayRootWorkCount({ excludeCurrent: true });
    const activeTasks = getInspectableActiveTaskRestartBlockers().length;
    return {
      queueSize,
      pendingReplies,
      embeddedRuns,
      backgroundExecSessions,
      rootRequests,
      activeTasks,
      totalActive:
        queueSize +
        pendingReplies +
        embeddedRuns +
        backgroundExecSessions +
        rootRequests +
        activeTasks,
    };
  };
  const formatActiveDetails = (counts: ReturnType<typeof getActiveCounts>) => {
    const details = [];
    if (counts.queueSize > 0) {
      details.push(`${counts.queueSize} operation(s)`);
    }
    if (counts.pendingReplies > 0) {
      details.push(`${counts.pendingReplies} reply(ies)`);
    }
    if (counts.embeddedRuns > 0) {
      details.push(`${counts.embeddedRuns} embedded run(s)`);
    }
    if (counts.backgroundExecSessions > 0) {
      details.push(`${counts.backgroundExecSessions} background exec session(s)`);
    }
    if (counts.rootRequests > 0) {
      details.push(`${counts.rootRequests} gateway request(s)`);
    }
    if (counts.activeTasks > 0) {
      details.push(`${counts.activeTasks} background task run(s)`);
    }
    return details;
  };
  const formatTaskBlockers = () => {
    const blockers = getInspectableActiveTaskRestartBlockers();
    if (blockers.length === 0) {
      return null;
    }
    const shown = blockers.slice(0, 8).map(formatActiveTaskRestartBlocker);
    const omitted = blockers.length - shown.length;
    return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
  };
  const waitForActiveWorkBeforeChannelReload = async (
    channels: Iterable<ChannelKind>,
    isTransactionCurrent: () => boolean,
  ): Promise<boolean> => {
    // Returns true when the wait was cancelled (restart or config supersession),
    // false when active work drained or timed out and channel reload may proceed.
    if (!isTransactionCurrent()) {
      return true;
    }
    const initial = getActiveCounts();
    if (initial.totalActive <= 0) {
      return false;
    }
    const channelNames = [...channels].join(", ");
    const initialDetails = formatActiveDetails(initial);
    params.logReload.warn(
      `config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(
        ", ",
      )} complete`,
    );
    const timeoutMs = resolveGatewayRestartDeferralTimeoutMs();
    const startedAt = Date.now();
    let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
    while (true) {
      if (!isTransactionCurrent() || isGatewayReloadGenerationAborted(myGeneration)) {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS);
        timer.unref?.();
      });
      if (!isTransactionCurrent() || isGatewayReloadGenerationAborted(myGeneration)) {
        return true;
      }
      const current = getActiveCounts();
      if (current.totalActive <= 0) {
        return false;
      }
      const elapsedMs = Date.now() - startedAt;
      if (timeoutMs !== undefined && elapsedMs >= timeoutMs) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload timeout after ${elapsedMs}ms with ${remaining.join(
            ", ",
          )} still active; reloading channels anyway`,
        );
        return false;
      }
      if (Date.now() >= nextStillPendingAt) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`,
        );
        nextStillPendingAt = Date.now() + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
      }
    }
  };

  return {
    formatActiveDetails,
    formatTaskBlockers,
    getActiveCounts,
    waitForActiveWorkBeforeChannelReload,
  };
}
