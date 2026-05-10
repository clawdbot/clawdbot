import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  type ProcessSession,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markExited,
  setJobTtlMs,
} from "./bash-process-registry.js";
import { describeProcessTool } from "./bash-tools.descriptions.js";
import { handleProcessSendKeys, type WritableStdin } from "./bash-tools.process-send-keys.js";
import { processSchema } from "./bash-tools.schemas.js";
import {
  clampWithDefault,
  deriveSessionName,
  pad,
  readEnvInt,
  sliceLogLines,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import { encodePaste } from "./pty-keys.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AgentToolWithMeta } from "./tools/common.js";

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

const MAX_POLL_WAIT_MS = 30_000;

type RunningSessionRuntime = {
  stdinWritable: boolean;
  waitingForInput: boolean;
  idleMs: number;
  lastOutputAt: number;
};

function resolveSessionStdin(session: ProcessSession): WritableStdin | undefined {
  return (session.stdin ?? session.child?.stdin) as WritableStdin | undefined;
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
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
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

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" ? reason : "Aborted");
  error.name = "AbortError";
  return error;
}

async function sleepPollInterval(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
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
    onAbort = () => {
      cleanup();
      reject(createAbortError(signal?.reason));
    };
    timer = setTimeout(onResolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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

  const cancelManagedSession = (sessionId: string) => {
    const record = supervisor.getRecord(sessionId);
    if (!record || record.state === "exited") {
      return false;
    }
    supervisor.cancel(sessionId, "manual-cancel");
    return true;
  };

  const terminateSessionFallback = (session: ProcessSession) => {
    const pid = session.pid ?? session.child?.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    killProcessTree(pid);
    return true;
  };

  return {
    name: "process",
    label: "process",
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    parameters: processSchema,
    execute: async (_toolCallId, args, signal, _onUpdate): Promise<AgentToolResult<unknown>> => {
      const params = args as {
        action:
          | "list"
          | "poll"
          | "log"
          | "write"
          | "send-keys"
          | "submit"
          | "paste"
          | "kill"
          | "clear"
          | "remove";
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
        const running = listRunningSessions()
          .filter((s) => isInScope(s))
          .map((s) => {
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
        const finished = listFinishedSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
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
          }));
        const lines = [...running, ...finished]
          .toSorted((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
            const marker = "waitingForInput" in s && s.waitingForInput ? " [input-wait]" : "";
            return `${s.sessionId} ${pad(s.status, 9)} ${
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
          details: { status: "completed", sessions: [...running, ...finished] },
        };
      }

      if (!params.sessionId) {
        return {
          content: [{ type: "text", text: "sessionId is required for this action." }],
          details: { status: "failed" },
        };
      }

      const session = getSession(params.sessionId);
      const finished = getFinishedSession(params.sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;

      const failedResult = (text: string): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: { status: "failed" },
      });

      const resolveBackgroundedWritableStdin = () => {
        if (!scopedSession) {
          return {
            ok: false as const,
            result: failedResult(`No active session found for ${params.sessionId}`),
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} is not backgrounded.`),
          };
        }
        const stdin = resolveSessionStdin(scopedSession);
        if (!isWritableStdin(stdin)) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} stdin is not writable.`),
          };
        }
        return { ok: true as const, session: scopedSession, stdin };
      };

      const writeToStdin = async (stdin: WritableStdin, data: string) => {
        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      };

      const runningSessionResult = (
        session: ProcessSession,
        text: string,
      ): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: {
          status: "running",
          sessionId: params.sessionId,
          name: deriveSessionName(session.command),
        },
      });

      switch (params.action) {
        case "poll": {
          if (!scopedSession) {
            if (scopedFinished) {
              resetPollRetrySuggestion(params.sessionId);
              return {
                content: [
                  {
                    type: "text",
                    text:
                      (scopedFinished.tail ||
                        `(no output recorded${
                          scopedFinished.truncated ? " — truncated to cap" : ""
                        })`) +
                      `\n\nProcess exited with ${
                        scopedFinished.exitSignal
                          ? `signal ${scopedFinished.exitSignal}`
                          : `code ${scopedFinished.exitCode ?? 0}`
                      }.`,
                  },
                ],
                details: {
                  status: scopedFinished.status === "completed" ? "completed" : "failed",
                  sessionId: params.sessionId,
                  exitCode: scopedFinished.exitCode ?? undefined,
                  aggregated: scopedFinished.aggregated,
                  name: deriveSessionName(scopedFinished.command),
                },
              };
            }
            resetPollRetrySuggestion(params.sessionId);
            return failText(`No session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          const pollWaitMs = resolvePollWaitMs(params.timeout);
          if (pollWaitMs > 0 && !scopedSession.exited) {
            const deadline = Date.now() + pollWaitMs;
            while (!scopedSession.exited && Date.now() < deadline) {
              await sleepPollInterval(Math.max(0, Math.min(250, deadline - Date.now())), signal);
            }
          }
          const { stdout, stderr } = drainSession(scopedSession);
          const exited = scopedSession.exited;
          const exitCode = scopedSession.exitCode ?? 0;
          const exitSignal = scopedSession.exitSignal ?? undefined;
          if (exited) {
            const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
            markExited(
              scopedSession,
              scopedSession.exitCode ?? null,
              scopedSession.exitSignal ?? null,
              status,
            );
          }
          const status = exited
            ? exitCode === 0 && exitSignal == null
              ? "completed"
              : "failed"
            : "running";
          const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
          const hasNewOutput = output.length > 0;
          const retryInMs = exited
            ? undefined
            : recordPollRetrySuggestion(params.sessionId, hasNewOutput);
          if (exited) {
            resetPollRetrySuggestion(params.sessionId);
          }
          const runtime = exited ? undefined : describeRunningSession(scopedSession);
          return {
            content: [
              {
                type: "text",
                text:
                  (output || "(no new output)") +
                  (exited
                    ? `\n\nProcess exited with ${
                        exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                      }.`
                    : buildInputWaitHint(runtime) || "\n\nProcess still running."),
              },
            ],
            details: {
              status,
              sessionId: params.sessionId,
              exitCode: exited ? exitCode : undefined,
              aggregated: scopedSession.aggregated,
              name: deriveSessionName(scopedSession.command),
              ...(runtime ? runningSessionInputDetails(runtime) : {}),
              ...(typeof retryInMs === "number" ? { retryInMs } : {}),
            },
          };
        }

        case "log": {
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Session ${params.sessionId} is not backgrounded.`,
                  },
                ],
                details: { status: "failed" },
              };
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
                    (slice || "(no output yet)") + logDefaultTailNote + buildInputWaitHint(runtime),
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
            const status = scopedFinished.status === "completed" ? "completed" : "failed";
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [
                { type: "text", text: (slice || "(no output recorded)") + logDefaultTailNote },
              ],
              details: {
                status,
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedFinished.truncated,
                exitCode: scopedFinished.exitCode ?? undefined,
                exitSignal: scopedFinished.exitSignal ?? undefined,
                name: deriveSessionName(scopedFinished.command),
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        case "write": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          await writeToStdin(resolved.stdin, params.data ?? "");
          if (params.eof) {
            resolved.stdin.end();
          }
          return runningSessionResult(
            resolved.session,
            `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${
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
          await writeToStdin(resolved.stdin, "\r");
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
            return {
              content: [
                {
                  type: "text",
                  text: "No paste text provided.",
                },
              ],
              details: { status: "failed" },
            };
          }
          await writeToStdin(resolved.stdin, payload);
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
          const canceled = cancelManagedSession(scopedSession.id);
          if (!canceled) {
            const terminated = terminateSessionFallback(scopedSession);
            if (!terminated) {
              return failText(
                `Unable to terminate session ${params.sessionId}: no active supervisor run or process id.`,
              );
            }
            markExited(scopedSession, null, "SIGKILL", "failed");
          }
          resetPollRetrySuggestion(params.sessionId);
          return {
            content: [
              {
                type: "text",
                text: canceled
                  ? `Termination requested for session ${params.sessionId}.`
                  : `Killed session ${params.sessionId}.`,
              },
            ],
            details: {
              status: "failed",
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
          return {
            content: [
              {
                type: "text",
                text: `No finished session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        case "remove": {
          if (scopedSession) {
            const canceled = cancelManagedSession(scopedSession.id);
            if (canceled) {
              // Keep remove semantics deterministic: drop from process registry now.
              scopedSession.backgrounded = false;
              deleteSession(params.sessionId);
            } else {
              const terminated = terminateSessionFallback(scopedSession);
              if (!terminated) {
                return failText(
                  `Unable to remove session ${params.sessionId}: no active supervisor run or process id.`,
                );
              }
              markExited(scopedSession, null, "SIGKILL", "failed");
              deleteSession(params.sessionId);
            }
            resetPollRetrySuggestion(params.sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: canceled
                    ? `Removed session ${params.sessionId} (termination requested).`
                    : `Removed session ${params.sessionId}.`,
                },
              ],
              details: {
                status: "failed",
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
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }
      }

      return {
        content: [{ type: "text", text: `Unknown action ${params.action as string}` }],
        details: { status: "failed" },
      };
    },
  };
}

export const processTool = createProcessTool();
