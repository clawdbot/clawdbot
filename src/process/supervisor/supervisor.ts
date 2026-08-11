// Process supervisor manages long-running child and PTY process lifecycles.
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
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

type StartingRun = {
  scopeKey?: string;
  terminationReason?: TerminationReason;
  cancel?: (reason: TerminationReason) => void;
};

type StartingScope = {
  runs: Set<Promise<ManagedRun>>;
  replacement?: Promise<ManagedRun>;
};

const GRACEFUL_CANCEL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;

const loadSupervisorLogRuntime = createLazyRuntimeModule(
  () => import("./supervisor-log.runtime.js"),
);

function normalizeTimeoutDuration(value?: number): number | undefined {
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
  if (
    params.overallTimeoutDeadlineMs !== null &&
    params.nowMs >= params.overallTimeoutDeadlineMs &&
    (params.noOutputTimeoutDeadlineMs === null ||
      params.nowMs < params.noOutputTimeoutDeadlineMs ||
      params.overallTimeoutDeadlineMs <= params.noOutputTimeoutDeadlineMs)
  ) {
    return "overall-timeout";
  }
  return params.noOutputTimeoutDeadlineMs !== null &&
    params.nowMs >= params.noOutputTimeoutDeadlineMs
    ? "no-output-timeout"
    : null;
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();
  const startingRuns = new Map<string, StartingRun>();
  const startingScopes = new Map<string, StartingScope>();

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (current) {
      current.run.cancel(reason);
      return;
    }

    const starting = startingRuns.get(runId);
    if (!starting) {
      return;
    }
    starting.terminationReason ??= reason;
    registry.updateState(runId, "exiting", {
      terminationReason: starting.terminationReason,
    });
    starting.cancel?.(starting.terminationReason);
  };

  const cancelActiveScope = (scopeKey: string, reason: TerminationReason) => {
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    cancelActiveScope(scopeKey, reason);
    for (const [runId, starting] of startingRuns.entries()) {
      if (starting.scopeKey === scopeKey) {
        cancel(runId, reason);
      }
    }
  };

  const startRun = async (
    input: SpawnInput,
    scopeKey: string | undefined,
    runId: string,
    startingRun: StartingRun,
  ): Promise<ManagedRun> => {
    const startedAtMs = Date.now();
    const startingTerminationReason = startingRun.terminationReason;
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey,
      state: startingTerminationReason ? "exiting" : "starting",
      ...(startingTerminationReason ? { terminationReason: startingTerminationReason } : {}),
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    if (startingTerminationReason) {
      // A replacement can be cancelled behind its scope fence. Never launch
      // its command or terminate the surviving scope after that cancellation.
      const exit: RunExit = {
        reason: startingTerminationReason,
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - startedAtMs,
        stdout: "",
        stderr: "",
        timedOut: isTimeoutReason(startingTerminationReason),
        noOutputTimedOut: startingTerminationReason === "no-output-timeout",
      };
      registry.finalize(runId, {
        reason: exit.reason,
        exitCode: exit.exitCode,
        exitSignal: exit.exitSignal,
      });
      return {
        runId,
        startedAtMs,
        wait: async () => exit,
        cancel: () => undefined,
      };
    }

    if (input.replaceExistingScope && scopeKey) {
      // Scope admission already waited for predecessor startups. Do not
      // cancel this replacement or later runs reserved behind its fence.
      cancelActiveScope(scopeKey, "manual-cancel");
    }

    let forcedReason: TerminationReason | null = startingRun.terminationReason ?? null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutListener = input.onStdout;
    let stderrListener = input.onStderr;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let cancelRequested = false;
    const captureOutput = input.captureOutput !== false;
    const maxCapturedOutputChars = clampCapturedOutputChars(input.maxCapturedOutputChars);

    const overallTimeoutMs = normalizeTimeoutDuration(input.timeoutMs);
    const noOutputTimeoutMs = normalizeTimeoutDuration(input.noOutputTimeoutMs);
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
    startingRun.cancel = requestCancel;

    // Node timers cannot hold the full duration of a long-running deadline.
    // Re-arm bounded intervals so the requested deadline is never shortened.
    const scheduleTimeout = (
      reason: "overall-timeout" | "no-output-timeout",
      remainingMs: number,
      deadlineMs: number,
    ): NodeJS.Timeout => {
      const intervalMs = resolveTimerTimeoutMs(remainingMs, 1);
      return setTimeout(() => {
        if (settled) {
          return;
        }
        const nextRemainingMs = Math.min(remainingMs - intervalMs, deadlineMs - performance.now());
        if (nextRemainingMs <= 0) {
          requestCancel(reason);
          return;
        }
        const nextTimer = scheduleTimeout(reason, nextRemainingMs, deadlineMs);
        if (reason === "overall-timeout") {
          timeoutTimer = nextTimer;
        } else {
          noOutputTimer = nextTimer;
        }
      }, intervalMs);
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
      noOutputTimer = scheduleTimeout(
        "no-output-timeout",
        noOutputTimeoutMs,
        noOutputTimeoutDeadlineMs,
      );
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
              secretInput: input.secretInput,
            });

      registry.updateState(runId, forcedReason ? "exiting" : "running", {
        pid: adapter.pid,
        ...(forcedReason ? { terminationReason: forcedReason } : {}),
      });

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

      cancelAdapter = (reason: TerminationReason) => {
        if (settled || cancelRequested) {
          return;
        }
        cancelRequested = true;
        // Windows has no catchable SIGTERM equivalent: the adapter implements it
        // with asynchronous taskkill, so waiting the cleanup grace only delays an
        // already-expired deadline before the same forced tree termination.
        if (
          process.platform === "win32" &&
          (reason === "overall-timeout" || reason === "no-output-timeout")
        ) {
          adapter.kill("SIGKILL");
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
        timeoutTimer = scheduleTimeout(
          "overall-timeout",
          overallTimeoutMs,
          overallTimeoutDeadlineMs,
        );
      }
      if (noOutputTimeoutMs) {
        noOutputTimeoutDeadlineMs = performance.now() + noOutputTimeoutMs;
        noOutputTimer = scheduleTimeout(
          "no-output-timeout",
          noOutputTimeoutMs,
          noOutputTimeoutDeadlineMs,
        );
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout = appendCapturedOutput(stdout, chunk, "stdout", maxCapturedOutputChars);
        }
        stdoutListener?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr = appendCapturedOutput(stderr, chunk, "stderr", maxCapturedOutputChars);
        }
        stderrListener?.(chunk);
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
          oomScoreWrapperSelected: adapter.oomScoreWrapperSelected === true,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(reason),
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
        detachOutput: () => {
          stdoutListener = undefined;
          stderrListener = undefined;
        },
      };

      active.set(runId, {
        run: managedRun,
        scopeKey,
      });
      if (forcedReason) {
        managedRun.cancel(forcedReason);
      }
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

  const spawn = (input: SpawnInput): Promise<ManagedRun> => {
    const scopeKey = normalizeOptionalString(input.scopeKey);
    const runId = normalizeOptionalString(input.runId) ?? crypto.randomUUID();
    const startingRun: StartingRun = { scopeKey };
    // Reserve cancellation before either adapter startup or a replacement
    // fence, so stopping a run cannot silently leave a late child alive.
    startingRuns.set(runId, startingRun);

    const starting = scopeKey
      ? (startingScopes.get(scopeKey) ?? { runs: new Set<Promise<ManagedRun>>() })
      : undefined;
    if (scopeKey && starting) {
      startingScopes.set(scopeKey, starting);
    }

    // Ordinary runs start together, but replacements fence later arrivals so
    // delayed cancellation cannot accidentally terminate a newer scoped run.
    const previous = starting
      ? input.replaceExistingScope
        ? Array.from(starting.runs)
        : starting.replacement
          ? [starting.replacement]
          : []
      : [];
    const pending =
      previous.length > 0
        ? Promise.allSettled(previous).then(() => startRun(input, scopeKey, runId, startingRun))
        : startRun(input, scopeKey, runId, startingRun);
    starting?.runs.add(pending);
    if (starting && input.replaceExistingScope) {
      starting.replacement = pending;
    }

    const clearPendingStart = () => {
      if (startingRuns.get(runId) === startingRun) {
        startingRuns.delete(runId);
      }
      starting?.runs.delete(pending);
      if (starting?.replacement === pending) {
        delete starting.replacement;
      }
      if (scopeKey && starting?.runs.size === 0 && startingScopes.get(scopeKey) === starting) {
        startingScopes.delete(scopeKey);
      }
    };
    void pending.then(clearPendingStart, clearPendingStart);
    return pending;
  };

  return {
    spawn,
    cancel,
    cancelScope,
    getRecord: (runId: string) => registry.get(runId),
  };
}
