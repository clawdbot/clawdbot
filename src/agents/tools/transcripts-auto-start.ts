import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveTranscriptsConfig,
  type ResolvedTranscriptsAutoStartConfig,
} from "../../transcripts/config.js";
import type {
  TranscriptOccupancyWatchHandle,
  TranscriptSourceLocator,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import { createTranscriptsStore, type TranscriptsStore } from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  activeSessions,
  createTranscriptSessionId,
  isTranscriptSessionStarting,
  resolveSourceProvider,
  resolveTranscriptSourceOwnership,
  sourceFromParams,
  startTranscripts,
  type TranscriptsRuntimeContext,
  type TranscriptsStartCandidate,
} from "./transcripts-tool-runtime.js";
import { stopTranscripts } from "./transcripts-tool-stop.js";

const AUTO_START_RETRY_ATTEMPTS = 12;
const AUTO_START_RETRY_MS = 5_000;
const AUTO_START_STOP_TIMEOUT_MS = 5_000;
const AUTO_START_PROVIDER_READY_TIMEOUT_MS = 30_000;
const AUTO_START_OCCUPANCY_EMPTY_GRACE_MS = 30_000;
const AUTO_START_OCCUPANCY_REOPEN_WINDOW_MS = 10 * 60_000;

type OwnedCapture = { sessionId: string; lifecycleToken: symbol };
type Timer = ReturnType<typeof setTimeout>;

function formatAutoStopDiagnostic(value: unknown): string {
  return JSON.stringify(truncateUtf16Safe(sanitizeTerminalText(formatErrorMessage(value)), 300));
}

async function waitForPendingAutoStartsToSettle(pending: Set<Promise<void>>): Promise<boolean> {
  if (!pending.size) {
    return true;
  }
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), AUTO_START_STOP_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own configured captures independently of the room's provider connection. */
export function createTranscriptsAutoStartService(ctx: TranscriptsRuntimeContext): {
  start: () => void;
  stop: () => Promise<void>;
} {
  let stopped = false;
  let started = false;
  const timers = new Set<Timer>();
  const watchers = new Set<TranscriptOccupancyWatchHandle>();
  const startedSessions = new Map<string, symbol>();
  const controllers = new Set<AbortController>();
  const pendingStarts = new Set<Promise<void>>();
  const pendingStops = new Set<Promise<void>>();
  const candidates = new Set<TranscriptsStartCandidate>();
  const guildOwners = new Map<string, number>();
  const schedule = (run: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, delay);
    timer.unref();
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: Timer | undefined) => {
    if (timer) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };
  const runPending = (run: (controller: AbortController) => Promise<void>) => {
    const controller = new AbortController();
    controllers.add(controller);
    const task = run(controller).finally(() => {
      controllers.delete(controller);
      pendingStarts.delete(task);
    });
    pendingStarts.add(task);
    return task;
  };
  const ownsCapture = (capture: OwnedCapture) =>
    activeSessions.get(capture.sessionId)?.lifecycleToken === capture.lifecycleToken;
  // A capture the runtime still owns (failed startup with pending cleanup) stays in
  // startedSessions so shutdown retries its exact stop; only released captures are forgotten.
  const forgetCapture = (capture: OwnedCapture) => {
    if (
      !ownsCapture(capture) &&
      startedSessions.get(capture.sessionId) === capture.lifecycleToken
    ) {
      startedSessions.delete(capture.sessionId);
    }
  };

  const discardCandidate = (candidate: TranscriptsStartCandidate, store: TranscriptsStore) => {
    const session = candidate.session;
    if (
      session &&
      (isTranscriptSessionStarting(session.sessionId) || activeSessions.has(session.sessionId))
    ) {
      return;
    }
    try {
      if (session && candidate.discardable) {
        store.deleteEmptySessionCandidate(session);
      }
      candidates.delete(candidate);
      delete candidate.session;
      delete candidate.discardable;
    } catch (error) {
      ctx.logger.warn(
        `transcripts autoStart candidate cleanup failed: ${formatAutoStopDiagnostic(error)}; empty candidate retained.`,
      );
    }
  };

  const stopCapture = async (capture: OwnedCapture, store: TranscriptsStore) => {
    const warnings: string[] = [];
    try {
      const { details } = await stopTranscripts({
        ctx,
        store,
        rawParams: { action: "stop", sessionId: capture.sessionId },
        lifecycleToken: capture.lifecycleToken,
      });
      // Log diagnostics only, never the tool content or captured meeting notes.
      if (typeof details.summaryExportError === "string") {
        warnings.push(
          `summary saved; export failed intendedSummaryPath=${formatAutoStopDiagnostic(details.intendedSummaryPath)}: ${formatAutoStopDiagnostic(details.summaryExportError)}. Correct the export destination, then run openclaw transcripts path <session> or openclaw transcripts show <session>.`,
        );
      }
      if (typeof details.providerStopError === "string") {
        warnings.push(
          `provider stop failed: ${formatAutoStopDiagnostic(details.providerStopError)}. Check the provider capture status and connection.`,
        );
      }
    } catch (error) {
      warnings.push(`stop failed: ${formatAutoStopDiagnostic(error)}`);
    }
    for (const warning of warnings) {
      ctx.logger.warn(
        `transcripts autoStart session=${formatAutoStopDiagnostic(capture.sessionId)}: ${warning}`,
      );
    }
    forgetCapture(capture);
  };

  const startContinuous = (
    entry: ResolvedTranscriptsAutoStartConfig & { sessionId: string },
    attempt: number,
    store: TranscriptsStore,
    candidate: TranscriptsStartCandidate = {},
  ) => {
    if (stopped || startedSessions.has(entry.sessionId)) {
      return;
    }
    candidates.add(candidate);
    const capture = { sessionId: entry.sessionId, lifecycleToken: Symbol(entry.sessionId) };
    // Startup can reject after accepting provider ownership; shutdown must still
    // find that exact capture when its first cleanup attempt fails.
    startedSessions.set(capture.sessionId, capture.lifecycleToken);
    void runPending(async (controller) => {
      try {
        await startTranscripts({
          ctx,
          store,
          abortSignal: controller.signal,
          startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
          configuredLifecycle: true,
          lifecycleToken: capture.lifecycleToken,
          candidate,
          rawParams: { action: "start", ...entry },
        });
        candidates.delete(candidate);
      } catch (error) {
        forgetCapture(capture);
        if (stopped) {
          // Startup may settle after the service's bounded shutdown wait.
          await stopCapture(capture, store);
          discardCandidate(candidate, store);
          return;
        }
        if (ownsCapture(capture)) {
          ctx.logger.warn(
            `transcripts autoStart session=${formatAutoStopDiagnostic(capture.sessionId)} still owns capture after startup failed: ${formatAutoStopDiagnostic(error)}; use transcripts stop to retry cleanup.`,
          );
        } else if (attempt >= AUTO_START_RETRY_ATTEMPTS) {
          discardCandidate(candidate, store);
          ctx.logger.warn(
            `transcripts autoStart failed provider=${entry.providerId}: ${formatAutoStopDiagnostic(error)} (check the transcripts.autoStart entry in your config)`,
          );
        } else {
          schedule(
            () => startContinuous(entry, attempt + 1, store, candidate),
            AUTO_START_RETRY_MS,
          );
        }
      }
    });
  };

  const watchEntry = (
    entry: ResolvedTranscriptsAutoStartConfig,
    index: number,
    store: TranscriptsStore,
  ) => {
    let occupied = false;
    let ready = false;
    let capture: OwnedCapture | undefined;
    let candidate: TranscriptsStartCandidate = {};
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let startController: AbortController | undefined;
    let emptyTimer: Timer | undefined;
    let retryTimer: Timer | undefined;
    let source: TranscriptSourceLocator;
    const label = `transcripts autoStart[${index}] provider=${entry.providerId}`;
    const retry = (
      run: () => void,
      attempt: number,
      error: unknown,
      phase: "watch" | "capture",
    ) => {
      if (stopped) {
        return;
      }
      if (attempt >= AUTO_START_RETRY_ATTEMPTS) {
        if (phase === "capture") {
          discardCandidate(candidate, store);
        }
        ctx.logger.warn(
          `${label} failed: ${formatAutoStopDiagnostic(error)}; check the entry and provider connection. ${phase === "watch" ? "Restart the gateway to retry occupancy watching." : "Waiting for the next occupancy transition."}`,
        );
        return;
      }
      cancel(retryTimer);
      retryTimer = schedule(run, AUTO_START_RETRY_MS);
    };
    const begin = (attempt: number) => {
      if (stopped || !ready || !occupied || starting || stopping) {
        return;
      }
      if (
        capture &&
        ownsCapture(capture) &&
        activeSessions.get(capture.sessionId)?.phase === "active"
      ) {
        return;
      }
      starting = runPending(async (controller) => {
        startController = controller;
        try {
          // A terminal persistence failure retains its old owner. Retire it through
          // the same stop path before reopening; never append behind finalization.
          if (capture && ownsCapture(capture)) {
            await stopCapture(capture, store);
            if (ownsCapture(capture)) {
              throw new Error("previous capture still awaits finalization");
            }
          }
          if (capture) {
            forgetCapture(capture);
          }
          if (stopped || !occupied || controller.signal.aborted) {
            return;
          }
          const now = Date.now();
          const recent =
            candidate.session ??
            store.readRecentStoppedSession(
              sanitizeTranscriptSourceLocator(source),
              new Date(now - AUTO_START_OCCUPANCY_REOPEN_WINDOW_MS).toISOString(),
              new Date(now).toISOString(),
            );
          if (
            recent &&
            !activeSessions.has(recent.sessionId) &&
            !isTranscriptSessionStarting(recent.sessionId) &&
            !startedSessions.has(recent.sessionId)
          ) {
            candidate.session = recent;
          } else {
            candidate = {};
            candidate.session = {
              sessionId: createTranscriptSessionId(),
              source: sanitizeTranscriptSourceLocator(source),
              startedAt: new Date(now).toISOString(),
              stoppedAt: new Date(now).toISOString(),
            };
          }
          const owned = {
            sessionId: candidate.session.sessionId,
            lifecycleToken: Symbol(label),
          };
          candidates.add(candidate);
          capture = owned;
          startedSessions.set(owned.sessionId, owned.lifecycleToken);
          const result = await startTranscripts({
            ctx,
            store,
            abortSignal: controller.signal,
            startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
            configuredLifecycle: true,
            lifecycleToken: owned.lifecycleToken,
            candidate,
            rawParams: { ...entry, ...source, sessionId: owned.sessionId },
            onCaptureEnded: () => {
              if (capture !== owned || stopped || !occupied) {
                return;
              }
              forgetCapture(owned);
              cancel(retryTimer);
              retryTimer = schedule(() => begin(1), AUTO_START_RETRY_MS);
            },
          });
          candidates.delete(candidate);
          candidate = {};
          if (result.details.active === false) {
            throw new Error("capture ended during startup");
          }
        } catch (error) {
          if (capture && !ownsCapture(capture)) {
            forgetCapture(capture);
            capture = undefined;
          }
          if (stopped) {
            if (capture) {
              await stopCapture(capture, store);
            }
            discardCandidate(candidate, store);
          } else if (occupied && !controller.signal.aborted) {
            retry(() => begin(attempt + 1), attempt, error, "capture");
          }
        } finally {
          startController = undefined;
        }
      }).finally(() => {
        starting = undefined;
      });
    };
    const end = () => {
      if (stopping) {
        return;
      }
      const task = (async () => {
        startController?.abort();
        await starting;
        // Settle callbacks before discarding a failed episode's empty admission.
        discardCandidate(candidate, store);
        candidate = {};
        if (capture) {
          await stopCapture(capture, store);
          if (!ownsCapture(capture)) {
            capture = undefined;
          }
        }
      })().finally(() => {
        stopping = undefined;
        pendingStops.delete(task);
        // Arrival during an awaited stop still gets an episode once the old
        // owner has released, rather than silently losing that transition.
        if (occupied && !stopped) {
          begin(1);
        }
      });
      stopping = task;
      pendingStops.add(task);
    };
    const arm = (attempt: number) => {
      if (stopped) {
        return;
      }
      void runPending(async (controller) => {
        try {
          const provider = resolveSourceProvider(entry.providerId, ctx.config);
          if (!provider) {
            throw new Error("provider is not available");
          }
          if (!provider.watchOccupancy) {
            ctx.logger.warn(
              `${label} cannot report occupancy; remove whenOccupied or select a provider that supports occupancy watching.`,
            );
            return;
          }
          source = resolveTranscriptSourceOwnership({
            ctx,
            operation: "start",
            provider,
            source: { ...sourceFromParams(entry), providerId: provider.id },
            configuredLifecycle: true,
          });
          // Guild voice transports own one connection per account. Claim before
          // awaiting readiness so later entries cannot displace the first room.
          if (source.guildId) {
            const key = JSON.stringify([provider.id, source.accountId, source.guildId]);
            const owner = guildOwners.get(key);
            if (owner !== undefined && owner !== index) {
              ctx.logger.warn(
                `${label} skipped: autoStart[${owner}] already owns this provider account and guild; configure only one whenOccupied entry per account and guild.`,
              );
              return;
            }
            guildOwners.set(key, index);
          }
          const result = await provider.watchOccupancy({
            cfg: ctx.config,
            source,
            abortSignal: controller.signal,
            startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
            onOccupied: () => {
              if (stopped || controller.signal.aborted || occupied) {
                return;
              }
              occupied = true;
              cancel(emptyTimer);
              cancel(retryTimer);
              begin(1);
            },
            onEmpty: () => {
              if (stopped || controller.signal.aborted || !occupied) {
                return;
              }
              occupied = false;
              cancel(retryTimer);
              cancel(emptyTimer);
              emptyTimer = schedule(end, AUTO_START_OCCUPANCY_EMPTY_GRACE_MS);
            },
          });
          if (!result.ok) {
            throw new Error(result.error);
          }
          if (stopped) {
            result.value.stop();
            return;
          }
          watchers.add(result.value);
          ready = true;
          // Initial occupancy can be reported inline by watchOccupancy. Admit
          // capture only after subscription succeeds, not after a failed watch.
          begin(1);
        } catch (error) {
          controller.abort();
          occupied = false;
          cancel(emptyTimer);
          retry(() => arm(attempt + 1), attempt, error, "watch");
        }
      });
    };
    arm(1);
  };

  return {
    start() {
      if (started || stopped) {
        return;
      }
      started = true;
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled || !config.autoStart.length) {
        return;
      }
      const store = createTranscriptsStore(ctx.stateDir);
      for (const [index, entry] of config.autoStart.entries()) {
        if (entry.whenOccupied) {
          watchEntry(entry, index, store);
        } else {
          startContinuous(
            { ...entry, sessionId: entry.sessionId ?? createTranscriptSessionId() },
            1,
            store,
          );
        }
      }
    },
    async stop() {
      stopped = true;
      for (const watcher of watchers) {
        watcher.stop();
      }
      watchers.clear();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const controller of controllers) {
        controller.abort();
      }
      const pendingStartsSettled = await waitForPendingAutoStartsToSettle(pendingStarts);
      if (!pendingStartsSettled) {
        ctx.logger.warn(
          `transcripts autoStart stop timed out waiting for ${pendingStarts.size} pending start${pendingStarts.size === 1 ? "" : "s"}`,
        );
      }
      if (pendingStartsSettled) {
        await Promise.allSettled(pendingStops);
      }
      const store = createTranscriptsStore(ctx.stateDir);
      for (const [sessionId, lifecycleToken] of startedSessions) {
        await stopCapture({ sessionId, lifecycleToken }, store);
      }
      startedSessions.clear();
      for (const candidate of candidates) {
        discardCandidate(candidate, store);
      }
    },
  };
}
