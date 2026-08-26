/**
 * Process-control tool factory.
 * Lists, polls, logs, writes to, sends keys to, pastes into, kills, clears,
 * and removes background exec sessions.
 */
import { createAbortError as createNamedAbortError } from "../infra/abort-signal.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { cancelBackgroundExecSession } from "./bash-process-control.js";
import {
  acknowledgeNotifyOnExit,
  type ProcessSession,
  compareProcessSessionStartOrder,
  deleteSession,
  drainFinishedSession,
  drainSession,
  getFinishedSession,
  getFinishedSessionForProcess,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markTerminalPollObserved,
  setJobTtlMs,
} from "./bash-process-registry.js";
import { describeProcessTool } from "./bash-tools.descriptions.js";
import { appendExecTimeoutRetryGuidance, renderExecExitLabel } from "./bash-tools.exec-output.js";
import {
  handleProcessSendKeys,
  type WritableStdin,
  writeProcessStdin,
} from "./bash-tools.process-send-keys.js";
import { processSchema } from "./bash-tools.schemas.js";
import {
  clampWithDefault,
  deriveSessionName,
  padProcessStatus,
  readEnvInt,
  sliceLogLines,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import { encodePaste } from "./pty-keys.js";
import type { AgentToolResult } from "./runtime/index.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AgentToolWithMeta } from "./tools/common.js";

/** Defaults injected by tests, agent scopes, and scoped process registries. */
export type ProcessToolDefaults = {
  cleanupMs?: number;
  hasCronTool?: boolean;
  inputWaitIdleMs?: number;
  scopeKey?: string;
};

const DEFAULT_LOG_TAIL_LINES = 200;
const DEFAULT_INPUT_WAIT_IDLE_MS = 15_000;
const MIN_INPUT_WAIT_IDLE_MS = 1_000;
const MAX_INPUT_WAIT_IDLE_MS = 10 * 60 * 1000;
const PROCESS_TOOL_ACTIONS = (
  processSchema.properties.action as typeof processSchema.properties.action & {
    enum: readonly string[];
  }
).enum;
type ProcessToolAction = (typeof PROCESS_TOOL_ACTIONS)[number];

function resolveLogSliceWindow(offset?: number, limit?: number) {
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : usingDefaultTail
        ? DEFAULT_LOG_TAIL_LINES
        : undefined;
  return { effectiveOffset: offset, effectiveLimit, usingDefaultTail };
}

function defaultTailNote(totalLines: number, usingDefaultTail: boolean) {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) {
    return "";
  }
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

function retentionCapNote(session: Pick<ProcessSession, "totalOutputChars" | "aggregated">) {
  return session.totalOutputChars > session.aggregated.length
    ? "\n\n[earlier output was discarded at the retention cap and cannot be recovered]"
    : "";
}

const MAX_POLL_WAIT_MS = 30_000;

type RunningSessionRuntime = {
  stdinWritable: boolean;
  waitingForInput: boolean;
  idleMs: number;
  lastOutputAt: number;
};

function resolveSessionStdin(session: ProcessSession): WritableStdin | undefined {
  return session.stdin as WritableStdin | undefined;
}

function isWritableStdin(stdin: WritableStdin | undefined): stdin is WritableStdin {
  if (!stdin || stdin.destroyed) {
    return false;
  }
  if (stdin.writable === false || stdin.writableEnded === true || stdin.writableFinished === true) {
    return false;
  }
  return true;
}

function runningSessionInputDetails(runtime: RunningSessionRuntime) {
  return {
    stdinWritable: runtime.stdinWritable,
    waitingForInput: runtime.waitingForInput,
    idleMs: runtime.idleMs,
    lastOutputAt: runtime.lastOutputAt,
  };
}

function resolvePollWaitMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) {
      return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
    }
  }
  return 0;
}

function failText(text: string): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { status: "failed" },
  };
}

function recordPollRetrySuggestion(sessionId: string, hasNewOutput: boolean): number | undefined {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    return recordCommandPoll(sessionState, sessionId, hasNewOutput);
  } catch {
    return undefined;
  }
}

function resetPollRetrySuggestion(sessionId: string): void {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    resetCommandPollCount(sessionState, sessionId);
  } catch {
    // Ignore diagnostics state failures for process tool behavior.
  }
}

type FinishedSession = NonNullable<ReturnType<typeof getFinishedSession>>;

function finishedSessionDetails(sessionId: string, finished: FinishedSession) {
  return {
    status: finished.status === "completed" ? "completed" : "failed",
    sessionId,
    exitCode: finished.exitCode ?? undefined,
    ...(finished.exitSignal != null ? { exitSignal: finished.exitSignal } : {}),
    ...(finished.exitReason
      ? {
          exitReason: finished.exitReason,
          timedOut:
            finished.exitReason === "overall-timeout" ||
            finished.exitReason === "no-output-timeout",
        }
      : {}),
    ...(finished.noOutputTimedOut !== undefined
      ? { noOutputTimedOut: finished.noOutputTimedOut }
      : {}),
    name: deriveSessionName(finished.command),
  };
}

function finishedPollResult(
  sessionId: string,
  finished: FinishedSession,
): AgentToolResult<unknown> {
  resetPollRetrySuggestion(sessionId);
  acknowledgeNotifyOnExit(finished);
  const { output: unreadOutput, outputDropped } = drainFinishedSession(finished);
  const output = unreadOutput.trim();
  // Omitted retained output is pageable only while this public id still owns
  // the exact snapshot; a reused slug must never point the model at successor logs.
  const retainedOutputNote = outputDropped
    ? getFinishedSession(sessionId) === finished
      ? "\n\n[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]"
      : "\n\n[earlier output is omitted from this poll; omitted output is no longer available through action=log]"
    : "";
  return {
    content: [
      {
        type: "text",
        text: appendExecTimeoutRetryGuidance(
          (output || "(no new output)") +
            retentionCapNote(finished) +
            retainedOutputNote +
            `\n\nProcess exited with ${renderExecExitLabel(finished)}.`,
          finished.exitReason,
        ),
      },
    ],
    details: {
      ...finishedSessionDetails(sessionId, finished),
      aggregated: finished.aggregated,
    },
  };
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return createNamedAbortError(typeof reason === "string" ? reason : "Aborted");
}

async function sleepPollInterval(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const onResolve = () => {
      cleanup();
      resolve();
    };
    const onAbort: (() => void) | undefined = () => {
      cleanup();
      reject(createAbortError(signal?.reason));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onResolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build the process-control tool with optional cleanup, scope, and input-idle defaults. */
export function createProcessTool(
  defaults?: ProcessToolDefaults,
): AgentToolWithMeta<typeof processSchema, unknown> {
  if (defaults?.cleanupMs !== undefined) {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;
  const supervisor = getProcessSupervisor();
  const inputWaitIdleMs = clampWithDefault(
    defaults?.inputWaitIdleMs ?? readEnvInt("OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS"),
    DEFAULT_INPUT_WAIT_IDLE_MS,
    MIN_INPUT_WAIT_IDLE_MS,
    MAX_INPUT_WAIT_IDLE_MS,
  );
  const isInScope = (session?: { scopeKey?: string } | null) =>
    !scopeKey || session?.scopeKey === scopeKey;

  const describeRunningSession = (session: ProcessSession): RunningSessionRuntime => {
    const record = supervisor.getRecord(session.id);
    const lastOutputAt = record?.lastOutputAtMs ?? session.startedAt;
    const idleMs = Math.max(0, Date.now() - lastOutputAt);
    const stdinWritable = isWritableStdin(resolveSessionStdin(session));
    return {
      stdinWritable,
      waitingForInput: stdinWritable && idleMs >= inputWaitIdleMs,
      idleMs,
      lastOutputAt,
    };
  };

  const buildInputWaitHint = (runtime: RunningSessionRuntime | undefined) => {
    if (!runtime?.waitingForInput) {
      return "";
    }
    const idle = formatDurationCompact(runtime.idleMs) ?? `${runtime.idleMs}ms`;
    return `\n\nNo new output for ${idle}; this session may be waiting for input. Use process write, send-keys, submit, or paste to provide input.`;
  };

  return {
    name: "process",
    label: "process",
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    parameters: processSchema,
    execute: async (_toolCallId, args, signal, _onUpdate): Promise<AgentToolResult<unknown>> => {
      const action = (args as { action?: unknown }).action;
      if (!PROCESS_TOOL_ACTIONS.includes(action as ProcessToolAction)) {
        return failText(
          `Invalid process action. Expected one of: ${PROCESS_TOOL_ACTIONS.join(", ")}`,
        );
      }
      const params = args as {
        action: ProcessToolAction;
        sessionId?: string;
        data?: string;
        keys?: string[];
        hex?: string[];
        literal?: string;
        text?: string;
        bracketed?: boolean;
        eof?: boolean;
        offset?: number;
        limit?: number;
        timeout?: unknown;
      };

      if (params.action === "list") {
        const sessions = [...listRunningSessions(), ...listFinishedSessions()]
          .filter((s) => isInScope(s))
          .toSorted(compareProcessSessionStartOrder)
          .map((s) => {
            if ("endedAt" in s) {
              return {
                sessionId: s.id,
                status: s.status,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                runtimeMs: s.endedAt - s.startedAt,
                cwd: s.cwd,
                command: s.command,
                name: deriveSessionName(s.command),
                tail: s.tail,
                truncated: s.truncated,
                exitCode: s.exitCode ?? undefined,
                exitSignal: s.exitSignal ?? undefined,
              };
            }
            const runtime = describeRunningSession(s);
            return {
              sessionId: s.id,
              status: "running",
              pid: s.pid ?? undefined,
              startedAt: s.startedAt,
              runtimeMs: Date.now() - s.startedAt,
              cwd: s.cwd,
              command: s.command,
              name: deriveSessionName(s.command),
              tail: s.tail,
              truncated: s.truncated,
              stdinWritable: runtime.stdinWritable,
              waitingForInput: runtime.waitingForInput,
              idleMs: runtime.idleMs,
              lastOutputAt: runtime.lastOutputAt,
            };
          });
        const lines = sessions.map((s) => {
          const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
          const marker = "waitingForInput" in s && s.waitingForInput ? " [input-wait]" : "";
          return `${s.sessionId} ${padProcessStatus(s.status, 9)} ${
            formatDurationCompact(s.runtimeMs) ?? "n/a"
          }${marker} :: ${label}`;
        });
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n") || "No running or recent sessions.",
            },
          ],
          details: { status: "completed", sessions },
        };
      }

      if (!params.sessionId) {
        return failText("sessionId is required for this action.");
      }

      const session = getSession(params.sessionId);
      const finished = getFinishedSession(params.sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;

      const resolveBackgroundedWritableStdin = () => {
        if (!scopedSession) {
          return {
            ok: false as const,
            result: failText(`No active session found for ${params.sessionId}`),
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            ok: false as const,
            result: failText(`Session ${params.sessionId} is not backgrounded.`),
          };
        }
        if (scopedSession.finalizing) {
          return {
            ok: false as const,
            result: failText(`Session ${params.sessionId} is finalizing.`),
          };
        }
        const stdin = resolveSessionStdin(scopedSession);
        if (!isWritableStdin(stdin)) {
          return {
            ok: false as const,
            result: failText(`Session ${params.sessionId} stdin is not writable.`),
          };
        }
        return { ok: true as const, session: scopedSession, stdin };
      };

      const runningSessionResult = (
        sessionLocal: ProcessSession,
        text: string,
      ): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: {
          status: "running",
          sessionId: params.sessionId,
          name: deriveSessionName(sessionLocal.command),
        },
      });

      switch (params.action) {
        case "poll": {
          if (!scopedSession) {
            if (scopedFinished) {
              return finishedPollResult(params.sessionId, scopedFinished);
            }
            resetPollRetrySuggestion(params.sessionId);
            return failText(`No session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          const pollWaitMs = resolvePollWaitMs(params.timeout);
          if (pollWaitMs > 0 && !scopedSession.exited) {
            if (signal?.aborted) {
              throw createAbortError(signal.reason);
            }
            const deadline = Date.now() + pollWaitMs;
            // Interactive children cannot progress until their pending prompt reaches the model.
            while (
              !scopedSession.exited &&
              scopedSession.pendingOutput.length === 0 &&
              !scopedSession.pendingOutputDropped &&
              Date.now() < deadline
            ) {
              await sleepPollInterval(Math.max(0, Math.min(250, deadline - Date.now())), signal);
            }
          }
          if (scopedSession.exited) {
            markTerminalPollObserved(scopedSession);
            // Exit finalization owns the terminal transition. Re-read by process
            // object because the public id may already index a successor.
            const finishedAfterWait = getFinishedSessionForProcess(scopedSession);
            if (finishedAfterWait && isInScope(finishedAfterWait)) {
              return finishedPollResult(params.sessionId, finishedAfterWait);
            }
            resetPollRetrySuggestion(params.sessionId);
            return failText(`No session found for ${params.sessionId}`);
          }
          const { output: unreadOutput, outputDropped } = drainSession(scopedSession);
          const output = unreadOutput.trim();
          const aggregateOutputNote = retentionCapNote(scopedSession);
          const retainedOutputNote = outputDropped
            ? "\n\n[earlier output is omitted from this poll; use action=log with offset and limit to inspect retained output]"
            : "";
          const hasNewOutput = output.length > 0;
          const retryInMs = recordPollRetrySuggestion(params.sessionId, hasNewOutput);
          const runtime = describeRunningSession(scopedSession);
          return {
            content: [
              {
                type: "text",
                text:
                  (output || "(no new output)") +
                  aggregateOutputNote +
                  retainedOutputNote +
                  (buildInputWaitHint(runtime) || "\n\nProcess still running."),
              },
            ],
            details: {
              status: "running",
              sessionId: params.sessionId,
              aggregated: scopedSession.aggregated,
              name: deriveSessionName(scopedSession.command),
              ...runningSessionInputDetails(runtime),
              ...(typeof retryInMs === "number" ? { retryInMs } : {}),
            },
          };
        }

        case "log": {
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return failText(`Session ${params.sessionId} is not backgrounded.`);
            }
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedSession.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const runtime = describeRunningSession(scopedSession);
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [
                {
                  type: "text",
                  text:
                    (slice || "(no output yet)") +
                    logDefaultTailNote +
                    retentionCapNote(scopedSession) +
                    buildInputWaitHint(runtime),
                },
              ],
              details: {
                status: scopedSession.exited ? "completed" : "running",
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedSession.truncated,
                name: deriveSessionName(scopedSession.command),
                ...runningSessionInputDetails(runtime),
              },
            };
          }
          if (scopedFinished) {
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedFinished.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            return {
              content: [
                {
                  type: "text",
                  text: appendExecTimeoutRetryGuidance(
                    (slice || "(no output recorded)") +
                      defaultTailNote(totalLines, window.usingDefaultTail) +
                      retentionCapNote(scopedFinished),
                    scopedFinished.exitReason,
                  ),
                },
              ],
              details: {
                ...finishedSessionDetails(params.sessionId, scopedFinished),
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedFinished.truncated,
              },
            };
          }
          return failText(`No session found for ${params.sessionId}`);
        }

        case "write": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          await writeProcessStdin(resolved.stdin, params.data ?? "");
          if (params.eof) {
            resolved.stdin.end();
          }
          return runningSessionResult(
            resolved.session,
            `Wrote ${Buffer.byteLength(params.data ?? "", "utf8")} bytes to session ${params.sessionId}${
              params.eof ? " (stdin closed)" : ""
            }.`,
          );
        }

        case "send-keys": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          return await handleProcessSendKeys({
            sessionId: params.sessionId,
            session: resolved.session,
            stdin: resolved.stdin,
            keys: params.keys,
            hex: params.hex,
            literal: params.literal,
          });
        }

        case "submit": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          await writeProcessStdin(resolved.stdin, "\r");
          return runningSessionResult(
            resolved.session,
            `Submitted session ${params.sessionId} (sent CR).`,
          );
        }

        case "paste": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          const payload = encodePaste(params.text ?? "", params.bracketed !== false);
          if (!payload) {
            return failText("No paste text provided.");
          }
          await writeProcessStdin(resolved.stdin, payload);
          return runningSessionResult(
            resolved.session,
            `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`,
          );
        }

        case "kill": {
          if (!scopedSession) {
            return failText(`No active session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          if (scopedSession.finalizing) {
            return failText(`Session ${params.sessionId} is finalizing.`);
          }
          if (!cancelBackgroundExecSession(scopedSession.id)) {
            return failText(
              `Unable to terminate session ${params.sessionId}: no active supervisor cancellation handle. Use process poll to check whether it is already exiting.`,
            );
          }
          resetPollRetrySuggestion(params.sessionId);
          // The kill was performed; "failed" here would flag a successful
          // action as a tool error and invite the model to retry it.
          return {
            content: [
              {
                type: "text",
                text: `Termination requested for session ${params.sessionId}.`,
              },
            ],
            details: {
              status: "completed",
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        case "clear": {
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Cleared session ${params.sessionId}.` }],
              details: { status: "completed" },
            };
          }
          return failText(`No finished session found for ${params.sessionId}`);
        }

        case "remove": {
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return failText(`Session ${params.sessionId} is not backgrounded.`);
            }
            if (scopedSession.finalizing) {
              return failText(`Session ${params.sessionId} is finalizing.`);
            }
            if (!cancelBackgroundExecSession(scopedSession.id)) {
              return failText(
                `Unable to remove session ${params.sessionId}: no active supervisor cancellation handle. Use process poll to check whether it is already exiting.`,
              );
            }
            // Keep remove semantics deterministic: drop from process registry now.
            scopedSession.backgrounded = false;
            deleteSession(params.sessionId);
            resetPollRetrySuggestion(params.sessionId);
            // Removal succeeded (termination requested + registry row dropped);
            // match the finished-session remove branch's success shape.
            return {
              content: [
                {
                  type: "text",
                  text: `Removed session ${params.sessionId} (termination requested).`,
                },
              ],
              details: {
                status: "completed",
                name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
              },
            };
          }
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Removed session ${params.sessionId}.` }],
              details: { status: "completed" },
            };
          }
          return failText(`No session found for ${params.sessionId}`);
        }
      }

      return failText(`Unknown action ${params.action as string}`);
    },
  };
}

/** Shared process-control tool instance used by the default Bash tool barrel. */
export const processTool = createProcessTool();
