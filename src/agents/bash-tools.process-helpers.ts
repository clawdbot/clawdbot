import { createAbortError as createNamedAbortError } from "../infra/abort-signal.js";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { prependRedactionWarning } from "./bash-tools.exec-output.js";
import {
  deriveRedactedProcessSessionName,
  redactProcessToolDetailsWithCommand,
} from "./bash-tools.process-redaction.js";
import type { WritableStdin } from "./bash-tools.process-send-keys.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import type { AgentToolResult } from "./runtime/index.js";

export const DEFAULT_INPUT_WAIT_IDLE_MS = 15_000;
export const MIN_INPUT_WAIT_IDLE_MS = 1_000;
export const MAX_INPUT_WAIT_IDLE_MS = 10 * 60 * 1000;

const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_POLL_WAIT_MS = 30_000;
const INTEGER_STRING_PATTERN = /^[+-]?\d+$/u;

export type RunningSessionRuntime = {
  stdinWritable: boolean;
  waitingForInput: boolean;
  idleMs: number;
  lastOutputAt: number;
};

export function resolveLogSliceWindow(offset?: number, limit?: number) {
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : usingDefaultTail
        ? DEFAULT_LOG_TAIL_LINES
        : undefined;
  return { effectiveOffset: offset, effectiveLimit, usingDefaultTail };
}

export function defaultTailNote(totalLines: number, usingDefaultTail: boolean) {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) {
    return "";
  }
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

export function resolveSessionStdin(session: ProcessSession): WritableStdin | undefined {
  return (session.stdin ?? session.child?.stdin) as WritableStdin | undefined;
}

export function isWritableStdin(stdin: WritableStdin | undefined): stdin is WritableStdin {
  if (!stdin || stdin.destroyed) {
    return false;
  }
  if (stdin.writable === false || stdin.writableEnded === true || stdin.writableFinished === true) {
    return false;
  }
  return true;
}

export function runningSessionInputDetails(runtime: RunningSessionRuntime) {
  return {
    stdinWritable: runtime.stdinWritable,
    waitingForInput: runtime.waitingForInput,
    idleMs: runtime.idleMs,
    lastOutputAt: runtime.lastOutputAt,
  };
}

export function resolvePollWaitMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!INTEGER_STRING_PATTERN.test(trimmed)) {
      return 0;
    }
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) {
      return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
    }
  }
  return 0;
}

export function failText(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: { status: "failed" },
  };
}

export function runningProcessSessionResult(
  sessionId: string,
  session: ProcessSession,
  text: string,
): AgentToolResult<unknown> {
  const details = redactProcessToolDetailsWithCommand(
    { status: "running", sessionId, name: deriveRedactedProcessSessionName(session.command) },
    session.command,
  );
  return {
    content: [{ type: "text", text: prependRedactionWarning(text, details.redacted === true) }],
    details,
  };
}

export function recordPollRetrySuggestion(
  sessionId: string,
  hasNewOutput: boolean,
): number | undefined {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    return recordCommandPoll(sessionState, sessionId, hasNewOutput);
  } catch {
    return undefined;
  }
}

export function resetPollRetrySuggestion(sessionId: string): void {
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
  return createNamedAbortError(typeof reason === "string" ? reason : "Aborted");
}

export async function sleepPollInterval(ms: number, signal?: AbortSignal): Promise<void> {
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
