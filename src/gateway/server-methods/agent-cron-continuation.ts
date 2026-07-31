import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { hasNewGeneratedMediaTaskForSessionKey } from "../../tasks/task-status-access.js";
import { formatForLog } from "../ws-log.js";
import {
  CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS,
  waitForCronContinuationReleaseRecovery,
  withoutCronRunContinuation,
} from "./agent-handler-helpers.js";
import type { CronContinuationClaim } from "./agent-session-persist.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createCronContinuationController(params: {
  runId: string;
  lifecycleGeneration: string;
  context: GatewayRequestHandlerOptions["context"];
}) {
  let claim: CronContinuationClaim | undefined;
  let recoveryScheduled = false;

  const release = async (outcome?: {
    terminalOutcome: AgentRunTerminalOutcome;
  }): Promise<boolean> => {
    const activeClaim = claim;
    if (!activeClaim) {
      return true;
    }
    const baseSessionKey = parseCronRunScopeSuffix(activeClaim.sessionKey).baseSessionKey;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const released = await applySessionEntryReplacements({
          activeSessionKey: activeClaim.sessionKey,
          requireWriteSuccess: true,
          sessionKeys:
            baseSessionKey && baseSessionKey !== activeClaim.sessionKey
              ? [activeClaim.sessionKey, baseSessionKey]
              : [activeClaim.sessionKey],
          skipMaintenance: false,
          storePath: activeClaim.storePath,
          update: (entries) => {
            const entriesByKey = new Map(
              entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
            );
            let current = entriesByKey.get(activeClaim.sessionKey);
            const marker = current?.cronRunContinuation;
            if (
              !current ||
              marker?.phase !== "continuing" ||
              marker.ownerRunId !== params.runId ||
              marker.lifecycleRevision !== activeClaim.lifecycleRevision
            ) {
              return { result: false };
            }
            const continuationCommittedWork =
              outcome?.terminalOutcome.reason === "completed" ||
              hasNewGeneratedMediaTaskForSessionKey(
                activeClaim.sessionKey,
                activeClaim.mediaTaskIdsBefore,
              );
            if (!continuationCommittedWork) {
              current = structuredClone(activeClaim.initialEntry);
            } else if (outcome?.terminalOutcome) {
              current.status =
                outcome.terminalOutcome.status === "ok"
                  ? "done"
                  : outcome.terminalOutcome.status === "timeout"
                    ? "timeout"
                    : "failed";
              current.endedAt = outcome.terminalOutcome.endedAt ?? Date.now();
            }
            const baseEntry = baseSessionKey ? entriesByKey.get(baseSessionKey) : undefined;
            const canPersistToBase =
              baseSessionKey !== undefined &&
              baseSessionKey !== activeClaim.sessionKey &&
              baseEntry?.lifecycleRevision === activeClaim.lifecycleRevision;
            const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
            if (continuationCommittedWork && canPersistToBase && baseEntry && baseSessionKey) {
              replacements.push({
                sessionKey: baseSessionKey,
                entry: mergeSessionSnapshotChanges({
                  initial: withoutCronRunContinuation(activeClaim.initialEntry),
                  next: withoutCronRunContinuation(current),
                  current: baseEntry,
                }),
              });
            }
            const releaseSourceMarker = continuationCommittedWork
              ? marker
              : (activeClaim.initialEntry.cronRunContinuation ?? marker);
            const {
              ownerRunId: _ownerRunId,
              ownerLifecycleGeneration: _ownerLifecycleGeneration,
              ...releasedMarker
            } = releaseSourceMarker;
            const baseWasSuperseded = Boolean(
              baseEntry && baseEntry.lifecycleRevision !== activeClaim.lifecycleRevision,
            );
            current.cronRunContinuation = {
              ...releasedMarker,
              phase: "ready",
              basePersisted:
                releasedMarker.basePersisted === true || canPersistToBase || baseWasSuperseded,
            };
            current.updatedAt = Date.now();
            replacements.push({ sessionKey: activeClaim.sessionKey, entry: current });
            return { replacements, result: true };
          },
        });
        claim = undefined;
        if (released && baseSessionKey) {
          emitSessionsChanged(params.context, {
            sessionKey: baseSessionKey,
            reason: "cron-continuation",
          });
        }
        return released;
      } catch (error) {
        params.context.logGateway.warn(
          `failed to release cron continuation ${params.runId} (${attempt}/3): ${formatForLog(error)}`,
        );
      }
    }
    return false;
  };

  const releaseWithRecovery = async (
    outcome?: { terminalOutcome: AgentRunTerminalOutcome },
    onRecovered?: () => void,
  ): Promise<boolean> => {
    const released = await release(outcome);
    const recoveryClaim = claim;
    if (released || !recoveryClaim || recoveryScheduled) {
      return released;
    }
    recoveryScheduled = true;
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      for (const delayMs of CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS) {
        await waitForCronContinuationReleaseRecovery(delayMs);
        if (
          claim !== recoveryClaim ||
          getAgentEventLifecycleGeneration() !== params.lifecycleGeneration
        ) {
          return;
        }
        if (await release(outcome)) {
          try {
            onRecovered?.();
          } catch (error) {
            params.context.logGateway.warn(
              `failed to refresh recovered cron continuation dedupe ${params.runId}: ${formatForLog(error)}`,
            );
          }
          return;
        }
      }
      params.context.logGateway.warn(
        `cron continuation release recovery exhausted for ${params.runId}`,
      );
    });
    return false;
  };

  return {
    releaseWithRecovery,
    setClaim: (value: CronContinuationClaim) => {
      claim = value;
    },
  };
}
