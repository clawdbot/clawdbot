// Process supervisor manages long-running child and PTY process lifecycles.
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
  TerminationReason,
} from "./types.js";

type OwnedRun = {
  runId: string;
  scopeKey?: string;
  terminationReason?: TerminationReason;
  cancel?: (reason: TerminationReason) => void;
  pending?: Promise<ManagedRun>;
  waitForExtinction?: () => Promise<void>;
};

type StartingScope = {
  runs: Set<Promise<ManagedRun>>;
  replacement?: Promise<ManagedRun>;
};

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

export function createProcessSupervisor(): ProcessSupervisor & {
  shutdown: () => Promise<void>;
  waitForScope: (scopeKey: string) => Promise<void>;
} {
  const registry = createRunRegistry();
  // Retries share a run ID while an older command can still own descendants.
  // Keep each admission until its own cleanup completes.
  const ownedRuns = new Set<OwnedRun>();
  const startingScopes = new Map<string, StartingScope>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const cancelOwner = (current: OwnedRun, reason: TerminationReason) => {
    if (current.cancel) {
      current.cancel(reason);
      return;
    }
    current.terminationReason ??= reason;
  };

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    for (const current of ownedRuns) {
      if (current.runId === runId) {
        cancelOwner(current, reason);
      }
    }
  };

  const cancelActiveScope = (scopeKey: string, reason: TerminationReason) => {
    for (const current of ownedRuns) {
      if (current.waitForExtinction && current.scopeKey === scopeKey) {
        cancelOwner(current, reason);
      }
    }
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const current of ownedRuns) {
      if (current.scopeKey === scopeKey) {
        cancelOwner(current, reason);
      }
    }
  };

  const waitForRuns = async (
    scopeKey: string | null,
    ignoreStartupFailures = false,
  ): Promise<void> => {
    let firstFailure: PromiseRejectedResult | undefined;
    while (true) {
      const selected = Array.from(ownedRuns).filter(
        (current) => scopeKey === null || current.scopeKey === scopeKey,
      );
      const starts = selected.flatMap((current) => (current.pending ? [current.pending] : []));
      const owned = selected.flatMap((current) =>
        current.waitForExtinction ? [current.waitForExtinction()] : [],
      );
      if (starts.length === 0 && owned.length === 0) {
        if (firstFailure) {
          throw firstFailure.reason;
        }
        return;
      }
      // Startup can become active while the snapshot settles; recheck admissions
      // so shutdown cannot outrun an admitted command or retained descendants.
      const results = await Promise.allSettled([...owned, ...starts]);
      firstFailure ??= results
        .slice(0, ignoreStartupFailures ? owned.length : undefined)
        .find((result): result is PromiseRejectedResult => result.status === "rejected");
    }
  };
  const waitForScope = (scopeKey: string): Promise<void> => waitForRuns(scopeKey);

  const startRun = async (input: SpawnInput, owner: OwnedRun): Promise<ManagedRun> => {
    // A queued replacement must still own authority before stopping the surviving run.
    if (!owner.terminationReason) {
      input.assertCurrent?.();
    }
    const { runId, scopeKey } = owner;
    const startedAtMs = Date.now();
    const startingTerminationReason = owner.terminationReason;
    const registration = registry.add({
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
    });

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
      registration.finalize(exit);
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

    let forcedReason: TerminationReason | null = owner.terminationReason ?? null;
    let resultSettled = false;
    let ownershipExtinct = false;
    const captured = { stdout: "", stderr: "" };
    // Forced settlement (kill-wait fallback, Windows forced close) resolves the
    // result while inherited pipes stay open, and callers finalize their own
    // output state from that terminal result. One fence closes every output path
    // together: a late chunk reaches no listener, capture buffer, or output clock.
    let outputDetached = false;
    const detachOutput = () => {
      outputDetached = true;
    };
    let forceKillTimer: NodeJS.Timeout | null = null;
    let cancelRequested = false;
    const captureOutput = input.captureOutput !== false;
    const maxCapturedOutputChars = clampCapturedOutputChars(input.maxCapturedOutputChars);

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason || resultSettled) {
        return;
      }
      forcedReason = reason;
      registration.updateState("exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;
    const constructionAbort = new AbortController();
    const constructionAbortError = new Error("adapter construction aborted");
    const constructionAbortPromise = new Promise<never>((_, reject) => {
      const rejectConstruction = () => reject(constructionAbortError);
      if (constructionAbort.signal.aborted) {
        rejectConstruction();
      } else {
        constructionAbort.signal.addEventListener("abort", rejectConstruction, { once: true });
      }
    });

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
      // Any cancel must abort construction: the relay may already be spawned
      // and waiting for ready, and a later deadline must not replace this reason.
      if (!cancelAdapter) {
        constructionAbort.abort();
      }
    };
    owner.cancel = requestCancel;

    const createDeadline = (reason: "overall-timeout" | "no-output-timeout", value?: number) => {
      const durationMs = normalizeTimeoutDuration(value);
      let deadlineMs: number | null = null;
      let timer: NodeJS.Timeout | undefined;
      // Re-arm bounded intervals: a long deadline must not overflow Node's timer cap.
      const schedule = (remainingMs: number, deadline: number) => {
        const intervalMs = resolveTimerTimeoutMs(remainingMs, 1);
        timer = setTimeout(() => {
          if (resultSettled) {
            return;
          }
          const remaining = Math.min(remainingMs - intervalMs, deadline - performance.now());
          if (remaining <= 0) {
            requestCancel(reason);
          } else {
            schedule(remaining, deadline);
          }
        }, intervalMs);
      };
      return {
        get deadlineMs() {
          return deadlineMs;
        },
        reset: () => {
          if (!durationMs || resultSettled) {
            return;
          }
          clearTimeout(timer);
          deadlineMs = performance.now() + durationMs;
          schedule(durationMs, deadlineMs);
        },
        clear: () => clearTimeout(timer),
      };
    };
    const overallDeadline = createDeadline("overall-timeout", input.timeoutMs);
    const outputDeadline = createDeadline("no-output-timeout", input.noOutputTimeoutMs);
    const touchOutput = () => {
      registration.touchOutput();
      outputDeadline.reset();
    };

    try {
      if (input.mode !== "anchored-shell" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      // Cover construction: secret-fd writes and relay ready have no inner deadline.
      overallDeadline.reset();
      outputDeadline.reset();
      const adapterPromise =
        input.mode === "pty"
          ? createPtyAdapter({
              assertCurrent: input.assertCurrent,
              shell: expectDefined(input.argv[0], "spawn executable"),
              args: input.argv.slice(1),
              cwd: input.cwd,
              env: input.env,
              abortSignal: constructionAbort.signal,
            })
          : input.mode === "anchored-shell"
            ? createChildAdapter({
                assertCurrent: input.assertCurrent,
                anchoredShellCommand: input.command,
                cwd: input.cwd,
                env: input.env,
                abortSignal: constructionAbort.signal,
              })
            : createChildAdapter({
                assertCurrent: input.assertCurrent,
                argv: input.argv,
                argv0: input.argv0,
                cwd: input.cwd,
                env: input.env,
                exactEnv: input.exactEnv,
                windowsVerbatimArguments: input.windowsVerbatimArguments,
                input: input.input,
                stdinMode: input.stdinMode,
                secretInput: input.secretInput,
                abortSignal: constructionAbort.signal,
              });
      let adapter: Awaited<typeof adapterPromise>;
      try {
        adapter = await Promise.race([adapterPromise, constructionAbortPromise]);
      } catch (err) {
        if (err !== constructionAbortError || !forcedReason) {
          throw err;
        }
        overallDeadline.clear();
        outputDeadline.clear();
        void adapterPromise.then(
          (started) => {
            started.kill("SIGKILL");
            started.dispose();
          },
          () => undefined,
        );
        const exit: RunExit = {
          reason: forcedReason,
          exitCode: null,
          exitSignal: null,
          durationMs: Date.now() - startedAtMs,
          stdout: "",
          stderr: "",
          timedOut: isTimeoutReason(forcedReason),
          noOutputTimedOut: forcedReason === "no-output-timeout",
        };
        registration.finalize(exit);
        return {
          runId,
          startedAtMs,
          wait: async () => exit,
          cancel: () => undefined,
        };
      }

      registration.updateState(forcedReason ? "exiting" : "running", {
        pid: adapter.pid,
        ...(forcedReason ? { terminationReason: forcedReason } : {}),
      });

      const releaseOwnership = () => {
        if (ownershipExtinct) {
          return;
        }
        ownershipExtinct = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        ownedRuns.delete(owner);
        // Control-channel extinction can precede independently drained output;
        // keep decoder subscriptions alive until the root result also settles.
        if (resultSettled) {
          adapter.dispose();
        }
      };

      const settleResult = () => {
        resultSettled = true;
        overallDeadline.clear();
        outputDeadline.clear();
        detachOutput();
        if (ownershipExtinct) {
          adapter.dispose();
        } else if (!adapter.waitForExtinction) {
          releaseOwnership();
        }
      };

      cancelAdapter = (reason: TerminationReason) => {
        if (ownershipExtinct || (cancelRequested && !(resultSettled && forceKillTimer))) {
          return;
        }
        cancelRequested = true;
        if (resultSettled) {
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
          // Root completion closes its terminal record, not ownership of
          // descendants still retained by the authoritative group or Job.
          adapter.kill("SIGKILL");
          return;
        }
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
          if (!ownershipExtinct) {
            adapter.kill("SIGKILL");
          }
        }, GRACEFUL_CANCEL_TIMEOUT_MS);
        forceKillTimer.unref?.();
      };

      const withOutputFence =
        <Chunk>(deliver?: (chunk: Chunk) => void, recordsOutput = true) =>
        (chunk: Chunk) => {
          if (outputDetached) {
            return;
          }
          if (recordsOutput) {
            touchOutput();
          }
          deliver?.(chunk);
        };
      const rawInput = input.mode === "child" ? input : undefined;
      // Byte transports can flush decoded text at EOF without fresh activity.
      // PTYs and Windows Job transports report only text.
      for (const [stream, subscribe, onText, onRaw] of [
        ["stdout", adapter.onStdout, input.onStdout, rawInput?.onStdoutRaw],
        ["stderr", adapter.onStderr, input.onStderr, rawInput?.onStderrRaw],
      ] as const) {
        subscribe(
          withOutputFence((chunk: string) => {
            if (captureOutput) {
              captured[stream] = appendCapturedOutput(
                captured[stream],
                chunk,
                stream,
                maxCapturedOutputChars,
              );
            }
            onText?.(chunk);
          }, !adapter.supportsRawOutput),
          withOutputFence(onRaw),
        );
      }

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        const deadlineReason = resolveElapsedTimeoutReason({
          nowMs: performance.now(),
          overallTimeoutDeadlineMs: overallDeadline.deadlineMs,
          noOutputTimeoutDeadlineMs: outputDeadline.deadlineMs,
        });
        const terminalReason = forcedReason ?? deadlineReason;
        settleResult();

        const reason: TerminationReason =
          terminalReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          oomScoreWrapperSelected: adapter.oomScoreWrapperSelected === true,
          durationMs: Date.now() - startedAtMs,
          ...captured,
          timedOut: isTimeoutReason(reason),
          noOutputTimedOut: terminalReason === "no-output-timeout",
        };
        registration.finalize(exit);
        return exit;
      })().catch((err: unknown) => {
        if (!resultSettled) {
          settleResult();
          registration.finalize({
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
        }
        throw err;
      });

      const extinctionPromise = adapter.waitForExtinction
        ? adapter.waitForExtinction().finally(releaseOwnership)
        : waitPromise.then(() => undefined);
      // Ownership failures remain observable through the explicit join, but a
      // caller waiting only for the root result must not create an unhandled rejection.
      void extinctionPromise.catch(() => undefined);

      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        ...(adapter.waitForExtinction && { waitForExtinction: () => extinctionPromise }),
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
        detachOutput,
      };

      owner.waitForExtinction = async () => await extinctionPromise;
      if (forcedReason) {
        managedRun.cancel(forcedReason);
      }
      return managedRun;
    } catch (err) {
      overallDeadline.clear();
      outputDeadline.clear();
      registration.finalize({
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
    if (shuttingDown) {
      return Promise.reject(new Error("process supervisor is shut down"));
    }
    const scopeKey = normalizeOptionalString(input.scopeKey);
    const runId = normalizeOptionalString(input.runId) ?? crypto.randomUUID();
    const owner: OwnedRun = { runId, scopeKey };
    // Reserve cancellation before either adapter startup or a replacement
    // fence, so stopping a run cannot silently leave a late child alive.
    ownedRuns.add(owner);

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
        ? Promise.allSettled(previous).then(() => startRun(input, owner))
        : startRun(input, owner);
    owner.pending = pending;
    starting?.runs.add(pending);
    if (starting && input.replaceExistingScope) {
      starting.replacement = pending;
    }

    const clearPendingStart = () => {
      delete owner.pending;
      if (!owner.waitForExtinction) {
        ownedRuns.delete(owner);
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

  const shutdown = (): Promise<void> => {
    // Publish the admission fence before cancellation can invoke owner callbacks.
    shuttingDown = true;
    return (shutdownPromise ??= Promise.resolve().then(async () => {
      while (ownedRuns.size) {
        for (const owner of ownedRuns) {
          cancelOwner(owner, "manual-cancel");
        }
        // A failed startup owns no live process; only failed owner extinction
        // must keep the process-wide supervisor fenced for operator recovery.
        await waitForRuns(null, true);
      }
    }));
  };

  return {
    spawn,
    cancel,
    cancelScope,
    shutdown,
    waitForScope,
    getRecord: (runId: string) => registry.get(runId),
  };
}
