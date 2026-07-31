/**
 * Post-restart interrupted-run resume for subagent sessions.
 *
 * After a SIGUSR1 gateway reload aborts in-flight subagent LLM calls,
 * this module scans for interrupted sessions (those with `abortedLastRun: true`
 * that are still tracked as active in the subagent registry) and sends a
 * synthetic resume message to restart their work. Parent notification is handled
 * separately by completion delivery after the child reaches a terminal result.
 *
 * @see https://github.com/openclaw/openclaw/issues/47711
 */

import crypto from "node:crypto";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { truncateUtf16Safe } from "../utils.js";
import { resolveInternalSessionEffectsTarget } from "./internal-session-effects.js";
import {
  evaluateSubagentRecoveryGate,
  markSubagentRecoveryAttempt,
  markSubagentRecoveryWedged,
} from "./subagent-recovery-state.js";
import {
  finalizeInterruptedSubagentRun,
  replaceSubagentRunAfterSteer,
  reserveSwarmCollectorLaunch,
} from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

const log = createSubsystemLogger("subagent-interrupted-resume");

/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5_000;

function isLegacyRestartInterruptedTimeout(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  return (
    entry?.abortedLastRun === true &&
    runRecord.outcome?.status === "timeout" &&
    typeof runRecord.endedAt === "number" &&
    runRecord.endedAt > 0
  );
}

function reclassifyLegacyRestartInterruptedRun(runRecord: SubagentRunRecord): void {
  const interruptedAt = runRecord.endedAt;
  runRecord.execution = {
    ...runRecord.execution,
    status: "interrupted",
    interruptedAt,
    interruptionReason: "gateway-restart",
    endedAt: undefined,
    outcome: undefined,
  };
  runRecord.endedAt = undefined;
  runRecord.endedReason = undefined;
  runRecord.outcome = undefined;
  runRecord.terminalOwner = undefined;
}

function loadRecoverySessionEntry(params: {
  childSessionKey: string;
  storePath: string;
}): SessionEntry | undefined {
  return loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.childSessionKey,
    clone: false,
  });
}

async function patchRecoverySessionEntry(params: {
  childSessionKey: string;
  storePath: string;
  update: (entry: SessionEntry) => void;
}): Promise<SessionEntry | null> {
  return await patchSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.childSessionKey,
    },
    (entry) => {
      params.update(entry);
      return entry;
    },
    {
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
}

/**
 * Build the resume message for an orphaned subagent.
 */
function buildResumeMessage(task: string, lastHumanMessage?: string): string {
  const maxTaskLen = 2000;
  const truncatedTask =
    task.length > maxTaskLen ? `${truncateUtf16Safe(task, maxTaskLen)}...` : task;

  let message =
    `[System] Your previous turn was interrupted by a gateway reload. ` +
    `Your original task was:\n\n${truncatedTask}\n\n`;

  if (lastHumanMessage) {
    message += `The last message from the user before the interruption was:\n\n${lastHumanMessage}\n\n`;
  }

  message += `Please continue where you left off.`;
  return message;
}

function extractMessageText(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter(
        (c: unknown) =>
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>).type === "text" &&
          typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c: unknown) => (c as Record<string, string>).text)
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

/**
 * Send a resume message through the owning Gateway's in-process agent dispatcher.
 */
async function resumeOrphanedSession(params: {
  gatewayRuntime: GatewayRecoveryRuntime;
  sessionKey: string;
  task: string;
  lastHumanMessage?: string;
  configChangeHint?: string;
  originalRunId: string;
  originalRun: SubagentRunRecord;
}): Promise<{ resumed: boolean; error?: string }> {
  let resumeMessage = buildResumeMessage(params.task, params.lastHumanMessage);
  if (params.configChangeHint) {
    resumeMessage += params.configChangeHint;
  }

  try {
    const idempotencyKey = crypto.randomUUID();
    if (
      params.originalRun.collect === true &&
      !reserveSwarmCollectorLaunch(params.originalRunId, idempotencyKey)
    ) {
      return { resumed: false, error: "failed to reserve collector recovery launch" };
    }
    const result = await params.gatewayRuntime.dispatchAgent<{ runId: string }>(
      {
        message: resumeMessage,
        sessionKey: params.sessionKey,
        idempotencyKey,
        deliver: false,
        lane: "subagent",
        ...(params.originalRun.collect
          ? {
              swarmCollector: true,
              swarmOutputSchema: params.originalRun.outputSchema,
            }
          : {}),
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.originalRun.requesterSessionKey,
          sourceChannel: "internal",
          sourceTool: "subagent_interrupted_resume",
        },
        sessionEffects: "internal",
        suppressPromptPersistence: true,
      },
      10_000,
    );
    const remapped = replaceSubagentRunAfterSteer({
      previousRunId: params.originalRunId,
      nextRunId: result.runId,
      fallback: params.originalRun,
      transcriptTarget: resolveInternalSessionEffectsTarget({
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        runId: result.runId,
        storePath: resolveStorePath(getRuntimeConfig().session?.store, {
          agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        }),
      }),
      // Persist the stable original task (not the synthetic resume wrapper) so
      // that any further post-restart redispatch reconstructs the same
      // canonical task. Persisting `resumeMessage` instead would accumulate a
      // wrapped-resume-of-resume cascade across repeated restarts.
      task: params.task,
    });
    if (!remapped) {
      log.warn(
        `resumed orphaned session ${params.sessionKey} but remap failed (old run already removed); treating resume as accepted to avoid duplicate restarts`,
      );
      return { resumed: true };
    }
    log.info(`resumed orphaned session: ${params.sessionKey}`);
    return { resumed: true };
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(`failed to resume orphaned session ${params.sessionKey}: ${error}`);
    return { resumed: false, error };
  }
}

/**
 * Scan for and resume orphaned subagent sessions after a gateway restart.
 *
 * An orphaned session is one where:
 * 1. It has an active (not ended) entry in the subagent run registry
 * 2. Its session store entry has `abortedLastRun: true`
 *
 * For each orphaned session found, we:
 * 1. Clear the `abortedLastRun` flag
 * 2. Send a synthetic resume message to trigger a new LLM turn
 */
export async function recoverOrphanedSubagentSessions(params: {
  gatewayRuntime: GatewayRecoveryRuntime;
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  /** Test seam for transcript reads; production uses the canonical reader. */
  readSessionMessages?: typeof readSessionMessagesAsync;
  /** Persisted across retries so already-resumed sessions are not resumed again. */
  resumedSessionKeys?: Set<string>;
  /** Exact stale generations whose terminal transition must retry without session state. */
  pendingStaleFinalizations?: Map<string, string>;
}): Promise<{
  recovered: number;
  failed: number;
  skipped: number;
  failedRuns: Array<{ runId: string; childSessionKey: string; error?: string }>;
}> {
  const result = {
    recovered: 0,
    failed: 0,
    skipped: 0,
    failedRuns: [] as Array<{ runId: string; childSessionKey: string; error?: string }>,
  };
  const resumedSessionKeys = params.resumedSessionKeys ?? new Set<string>();
  const pendingStaleFinalizations = params.pendingStaleFinalizations ?? new Map<string, string>();
  const readSessionMessages = params.readSessionMessages ?? readSessionMessagesAsync;
  const configChangePattern = /openclaw\.json|openclaw gateway restart|config\.patch/i;

  try {
    const activeRuns = params.getActiveRuns();
    if (activeRuns.size === 0) {
      return result;
    }

    let cfg: ReturnType<typeof getRuntimeConfig> | undefined;
    const scanNow = Date.now();
    const runEntries = [...activeRuns.entries()].toSorted(([, left], [, right]) => {
      const leftIsStale = isStaleUnendedSubagentRun(left, scanNow);
      const rightIsStale = isStaleUnendedSubagentRun(right, scanNow);
      return Number(rightIsStale) - Number(leftIsStale);
    });

    for (const [runId, runRecord] of runEntries) {
      const childSessionKey = runRecord.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      const now = scanNow;
      if (
        runRecord.terminalOwner === "interrupted-recovery" &&
        Number.isFinite(runRecord.endedAt) &&
        runRecord.outcome?.status === "error" &&
        runRecord.endedReason === "subagent-error" &&
        runRecord.pauseReason !== "sessions_yield"
      ) {
        const recoveryError =
          runRecord.outcome?.status === "error"
            ? (runRecord.outcome.error ?? "subagent run interrupted by gateway restart")
            : "subagent run interrupted by gateway restart";
        try {
          const updated = await finalizeInterruptedSubagentRun({
            runId,
            error: recoveryError,
            endedAt: runRecord.endedAt,
          });
          if (updated === 0) {
            result.failed++;
            result.failedRuns.push({ runId, childSessionKey, error: recoveryError });
          } else {
            pendingStaleFinalizations.delete(runId);
            result.skipped++;
          }
        } catch (err: unknown) {
          const error = formatErrorMessage(err);
          log.warn(`replay interrupted terminal ${runId}: ${error}`);
          result.failed++;
          result.failedRuns.push({ runId, childSessionKey, error });
        }
        continue;
      }
      const pendingStaleError = pendingStaleFinalizations.get(runId);
      if (pendingStaleError) {
        try {
          const updated = await finalizeInterruptedSubagentRun({
            runId,
            error: pendingStaleError,
          });
          if (updated === 0) {
            result.failed++;
            result.failedRuns.push({ runId, childSessionKey, error: pendingStaleError });
          } else {
            pendingStaleFinalizations.delete(runId);
            result.skipped++;
          }
        } catch (err: unknown) {
          const error = formatErrorMessage(err);
          log.warn(`retry stale terminal ${runId}: ${error}`);
          result.failed++;
          result.failedRuns.push({ runId, childSessionKey, error });
        }
        continue;
      }
      if (resumedSessionKeys.has(childSessionKey)) {
        result.skipped++;
        continue;
      }
      try {
        cfg ??= getRuntimeConfig();
        const agentId = resolveAgentIdFromSessionKey(childSessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });
        const entry = loadRecoverySessionEntry({ storePath, childSessionKey });
        if (!entry) {
          result.skipped++;
          continue;
        }

        if (isLegacyRestartInterruptedTimeout(runRecord, entry)) {
          reclassifyLegacyRestartInterruptedRun(runRecord);
        }

        // Terminal child outcomes are immutable. Restart resume only applies to
        // non-terminal interrupted execution; delivery retry handles terminal
        // child results separately.
        if (typeof runRecord.endedAt === "number" && runRecord.endedAt > 0) {
          result.skipped++;
          continue;
        }

        if (!entry.abortedLastRun) {
          result.skipped++;
          continue;
        }

        // Runs that are too old to be worth recovering must be finalized
        // so they don't remain in an unended state. The scheduler only
        // retries failedRuns; a plain skip would leave the run orphaned.
        if (isStaleUnendedSubagentRun(runRecord, now)) {
          const staleStartedAt = getSubagentSessionStartedAt(runRecord) ?? now;
          const staleAgeSeconds = Math.round((now - staleStartedAt) / 1000);
          const staleError = `stale aborted subagent run not resumed (${staleAgeSeconds}s old, exceeds stale-run window)`;
          try {
            const updated = await finalizeInterruptedSubagentRun({
              runId,
              error: staleError,
            });
            if (updated === 0) {
              pendingStaleFinalizations.set(runId, staleError);
              result.failed++;
              result.failedRuns.push({
                runId,
                childSessionKey,
                error: staleError,
              });
            } else {
              pendingStaleFinalizations.delete(runId);
              result.skipped++;
            }
          } catch (err: unknown) {
            const error = formatErrorMessage(err);
            log.warn(`finalize stale run ${runId}: ${error}`);
            pendingStaleFinalizations.set(runId, staleError);
            result.failed++;
            result.failedRuns.push({
              runId,
              childSessionKey,
              error,
            });
          }
          continue;
        }

        const recoveryGate = evaluateSubagentRecoveryGate(entry, now);
        if (!recoveryGate.allowed) {
          if (recoveryGate.shouldMarkWedged) {
            try {
              const updated = await patchRecoverySessionEntry({
                storePath,
                childSessionKey,
                update: (current) => {
                  markSubagentRecoveryWedged({
                    entry: current,
                    now,
                    runId,
                    reason: recoveryGate.reason,
                  });
                },
              });
              if (updated) {
                Object.assign(entry, updated);
              }
            } catch (err) {
              log.warn(
                `failed to persist wedged subagent recovery marker for ${childSessionKey}: ${String(err)}`,
              );
            }
          }
          log.warn(`skipping orphan recovery for ${childSessionKey}: ${recoveryGate.reason}`);
          result.skipped++;
          result.failedRuns.push({
            runId,
            childSessionKey,
            error: recoveryGate.reason,
          });
          continue;
        }

        log.info(`found orphaned subagent session: ${childSessionKey} (run=${runId})`);

        const messages = await readSessionMessages(
          {
            agentId: resolveAgentIdFromSessionKey(childSessionKey),
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: childSessionKey,
            storePath,
          },
          {
            mode: "recent",
            maxMessages: 200,
            maxBytes: 1024 * 1024,
          },
        );
        const lastHumanMessage = [...messages]
          .toReversed()
          .find((msg) => (msg as { role?: unknown } | null)?.role === "user");
        const configChangeDetected = messages.some((msg) => {
          if ((msg as { role?: unknown } | null)?.role !== "assistant") {
            return false;
          }
          const text = extractMessageText(msg);
          return typeof text === "string" && configChangePattern.test(text);
        });

        // Resume the session with the original task context.
        // We intentionally do NOT clear abortedLastRun before attempting
        // the resume — if instance dispatch fails (e.g. Gateway still booting),
        // the flag stays true so the next restart can retry.
        const resumeResult = await resumeOrphanedSession({
          gatewayRuntime: params.gatewayRuntime,
          sessionKey: childSessionKey,
          task: runRecord.task,
          lastHumanMessage: extractMessageText(lastHumanMessage),
          configChangeHint: configChangeDetected
            ? "\n\n[config changes from your previous run were already applied — do not re-modify openclaw.json or restart the gateway]"
            : undefined,
          originalRunId: runId,
          originalRun: runRecord,
        });

        if (resumeResult.resumed) {
          resumedSessionKeys.add(childSessionKey);
          // Only clear the aborted flag after confirmed successful resume.
          try {
            await patchRecoverySessionEntry({
              storePath,
              childSessionKey,
              update: (current) => {
                current.abortedLastRun = false;
                markSubagentRecoveryAttempt({
                  entry: current,
                  now: Date.now(),
                  runId,
                  attempt: recoveryGate.nextAttempt,
                });
                current.updatedAt = Date.now();
              },
            });
          } catch (err) {
            log.warn(
              `resume succeeded but failed to update session store for ${childSessionKey}: ${String(err)}`,
            );
          }
          result.recovered++;
        } else {
          // Flag stays as abortedLastRun=true so next restart can retry
          log.warn(
            `resume failed for ${childSessionKey}; abortedLastRun flag preserved for retry on next restart`,
          );
          result.failed++;
          result.failedRuns.push({
            runId,
            childSessionKey,
            error: resumeResult.error,
          });
        }
      } catch (err) {
        const error = formatErrorMessage(err);
        log.warn(`error processing orphaned session ${childSessionKey}: ${error}`);
        result.failed++;
        result.failedRuns.push({
          runId,
          childSessionKey,
          error,
        });
      }
    }
  } catch (err) {
    log.warn(`orphan recovery scan failed: ${String(err)}`);
    // Ensure retry logic fires for scan-level exceptions.
    if (result.failed === 0) {
      result.failed = 1;
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `orphan recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }

  return result;
}

/** Maximum number of retry attempts for orphan recovery. */
const MAX_RECOVERY_RETRIES = 3;
/** Backoff multiplier between retries (exponential). */
const RETRY_BACKOFF_MULTIPLIER = 2;
/** Separate durable-terminal attempts after session recovery is exhausted. */
const MAX_TERMINAL_FINALIZE_ATTEMPTS = 3;

function buildRecoveryFailureMessage(params: { attempts: number; error?: string }): string {
  const base =
    `Subagent run was interrupted by a gateway restart or connection loss. ` +
    `Automatic recovery failed after ${params.attempts} attempt${params.attempts === 1 ? "" : "s"}. ` +
    `Please retry.`;
  const detail = params.error?.trim();
  if (!detail) {
    return base;
  }
  return `${base} (${detail})`;
}

async function finalizeInterruptedRunWithRetry(params: {
  runId: string;
  error: string;
  initialDelayMs: number;
}): Promise<boolean> {
  let delayMs = Math.max(1, params.initialDelayMs);
  for (let attempt = 1; attempt <= MAX_TERMINAL_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      const updated = await finalizeInterruptedSubagentRun({
        runId: params.runId,
        error: params.error,
      });
      if (updated > 0) {
        return true;
      }
    } catch {
      // The outer scheduler owns this exact-run retry budget.
    }
    if (attempt < MAX_TERMINAL_FINALIZE_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
      delayMs *= RETRY_BACKOFF_MULTIPLIER;
    }
  }
  return false;
}

/**
 * Schedule orphan recovery after a delay, with retry logic.
 * The delay gives the gateway time to fully bootstrap after restart.
 * If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
 */
export function scheduleOrphanRecovery(params: {
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  /** Test seam for transcript reads; production uses the canonical reader. */
  readSessionMessages?: typeof readSessionMessagesAsync;
  delayMs?: number;
  maxRetries?: number;
}): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;

  const resumedSessionKeys = new Set<string>();
  const pendingStaleFinalizations = new Map<string, string>();
  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      // Every delayed/retry scan owns a fresh root lease. Keep terminal
      // mutation in the same lease so suspension cannot become ready mid-attempt.
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        // Resolve at attempt time so a Gateway replacement cannot leave a
        // debounced recovery bound to the closed instance it was scheduled by.
        const gatewayRuntime = params.getGatewayRuntime();
        if (!gatewayRuntime) {
          if (attempt < maxRetries) {
            attemptRecovery(attempt + 1, delay * RETRY_BACKOFF_MULTIPLIER);
          }
          return;
        }
        const result = await recoverOrphanedSubagentSessions({
          gatewayRuntime,
          getActiveRuns: params.getActiveRuns,
          readSessionMessages: params.readSessionMessages ?? readSessionMessagesAsync,
          resumedSessionKeys,
          pendingStaleFinalizations,
        });
        if (result.failed > 0 && attempt < maxRetries) {
          const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
          log.info(
            `orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          attemptRecovery(attempt + 1, nextDelay);
          return;
        }
        if (result.failedRuns.length === 0) {
          return;
        }
        const attempts = attempt + 1;
        const terminalResults = await Promise.all(
          result.failedRuns.map(async (run) => ({
            runId: run.runId,
            completed: await finalizeInterruptedRunWithRetry({
              runId: run.runId,
              error: buildRecoveryFailureMessage({ attempts, error: run.error }),
              initialDelayMs: delay,
            }),
          })),
        );
        const incomplete = terminalResults
          .filter((terminal) => !terminal.completed)
          .map((terminal) => terminal.runId);
        if (incomplete.length > 0) {
          log.warn(
            `orphan recovery exhausted with ${incomplete.length} interrupted terminal projection(s) incomplete`,
            { runIds: incomplete },
          );
        }
      }).catch((err: unknown) => {
        if (attempt < maxRetries) {
          const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
          log.warn(
            `scheduled orphan recovery failed: ${String(err)}; retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          attemptRecovery(attempt + 1, nextDelay);
        } else {
          log.warn(`scheduled orphan recovery failed after ${maxRetries} retries: ${String(err)}`);
        }
      });
    }, delay).unref?.();
  };

  attemptRecovery(0, initialDelay);
}
