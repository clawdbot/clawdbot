// Process supervisor manages long-running child and PTY process lifecycles.
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getShellConfig } from "../../agents/shell-utils.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";

type ActiveRun = {
  run: ManagedRun;
  scopeKey?: string;
};

const GRACEFUL_CANCEL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;

const loadSupervisorLogRuntime = createLazyRuntimeModule(
  () => import("./supervisor-log.runtime.js"),
);

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function clampCapturedOutputChars(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_CAPTURED_OUTPUT_CHARS;
  }
  return Math.max(256, Math.floor(value));
}

function appendCapturedOutput(
  current: string,
  chunk: string,
  stream: "stdout" | "stderr",
  maxChars: number,
) {
  const next = current + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  const marker = `[openclaw: captured ${stream} truncated to last ${maxChars} chars]\n`;
  const tailChars = Math.max(0, maxChars - marker.length);
  return `${marker}${sliceUtf16Safe(next, -tailChars)}`;
}

function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

function resolveElapsedTimeoutReason(params: {
  nowMs: number;
  overallTimeoutDeadlineMs: number | null;
  noOutputTimeoutDeadlineMs: number | null;
}): TerminationReason | null {
  const elapsedDeadlines: Array<{ reason: TerminationReason; deadlineMs: number }> = [];
  if (params.overallTimeoutDeadlineMs !== null && params.nowMs >= params.overallTimeoutDeadlineMs) {
    elapsedDeadlines.push({
      reason: "overall-timeout",
      deadlineMs: params.overallTimeoutDeadlineMs,
    });
  }
  if (
    params.noOutputTimeoutDeadlineMs !== null &&
    params.nowMs >= params.noOutputTimeoutDeadlineMs
  ) {
    elapsedDeadlines.push({
      reason: "no-output-timeout",
      deadlineMs: params.noOutputTimeoutDeadlineMs,
    });
  }
  if (elapsedDeadlines.length === 0) {
    return null;
  }
  elapsedDeadlines.sort((a, b) => a.deadlineMs - b.deadlineMs);
  return expectDefined(elapsedDeadlines[0], "elapsed deadlines entry at 0").reason;
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (!current) {
      return;
    }
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    current.run.cancel(reason);
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = normalizeOptionalString(input.runId) ?? crypto.randomUUID();
    const scopeKey = normalizeOptionalString(input.scopeKey);
    if (input.replaceExistingScope && scopeKey) {
      cancelScope(scopeKey, "manual-cancel");
    }
    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey,
      state: "starting",
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;
    const maxCapturedOutputChars = clampCapturedOutputChars(input.maxCapturedOutputChars);

    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);
    let overallTimeoutDeadlineMs: number | null = null;
    let noOutputTimeoutDeadlineMs: number | null = null;

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      noOutputTimeoutDeadlineMs = performance.now() + noOutputTimeoutMs;
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      const adapter =
        input.mode === "pty"
          ? await (async () => {
              const { shell, args: shellArgs } = getShellConfig();
              const ptyCommand = input.ptyCommand.trim();
              if (!ptyCommand) {
                throw new Error("PTY command cannot be empty");
              }
              return await createPtyAdapter({
                shell,
                args: [...shellArgs, ptyCommand],
                cwd: input.cwd,
                env: input.env,
              });
            })()
          : await createChildAdapter({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env,
              windowsVerbatimArguments: input.windowsVerbatimArguments,
              input: input.input,
              stdinMode: input.stdinMode,
            });

      registry.updateState(runId, "running", { pid: adapter.pid });

      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (noOutputTimer) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };

      cancelAdapter = (_reason: TerminationReason) => {
        if (settled || forceKillTimer) {
          return;
        }
        adapter.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            adapter.kill("SIGKILL");
          }
        }, GRACEFUL_CANCEL_TIMEOUT_MS);
        forceKillTimer.unref?.();
      };

      if (overallTimeoutMs) {
        overallTimeoutDeadlineMs = performance.now() + overallTimeoutMs;
        timeoutTimer = setTimeout(() => {
          requestCancel("overall-timeout");
        }, overallTimeoutMs);
      }
      if (noOutputTimeoutMs) {
        noOutputTimeoutDeadlineMs = performance.now() + noOutputTimeoutMs;
        noOutputTimer = setTimeout(() => {
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout = appendCapturedOutput(stdout, chunk, "stdout", maxCapturedOutputChars);
        }
        input.onStdout?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr = appendCapturedOutput(stderr, chunk, "stderr", maxCapturedOutputChars);
        }
        input.onStderr?.(chunk);
        touchOutput();
      });

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        const deadlineReason = resolveElapsedTimeoutReason({
          nowMs: performance.now(),
          overallTimeoutDeadlineMs,
          noOutputTimeoutDeadlineMs,
        });
        const terminalReason = forcedReason ?? deadlineReason;
        if (settled) {
          return {
            reason: terminalReason ?? "exit",
            exitCode: result.code,
            exitSignal: result.signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(terminalReason ?? "exit"),
            noOutputTimedOut: terminalReason === "no-output-timeout",
          };
        }
        settled = true;
        clearTimers();
        adapter.dispose();
        active.delete(runId);

        const reason: TerminationReason =
          terminalReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(terminalReason ?? reason),
          noOutputTimedOut: terminalReason === "no-output-timeout",
        };
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        return exit;
      })().catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          adapter.dispose();
          registry.finalize(runId, {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
        }
        throw err;
      });

      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
      };

      active.set(runId, {
        run: managedRun,
        scopeKey,
      });
      return managedRun;
    } catch (err) {
      registry.finalize(runId, {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
      });
      const { warnProcessSupervisorSpawnFailure } = await loadSupervisorLogRuntime();
      warnProcessSupervisorSpawnFailure(`spawn failed: runId=${runId} reason=${String(err)}`);
      throw err;
    }
  };

  return {
    spawn,
    cancel,
    cancelScope,
    getRecord: (runId: string) => registry.get(runId),
  };
}
