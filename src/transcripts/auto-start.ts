import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { truncateUtf16Safe } from "../utils.js";
import { createTranscriptsStore, stopTranscriptCapture } from "./capture-operations.js";
import {
  activeSessions,
  createTranscriptSessionId,
  isTranscriptSessionStarting,
  resolveSourceProvider,
  resolveTranscriptSourceOwnership,
  retainTranscriptStartRetry,
  sourceFromParams,
  startTranscripts,
  TranscriptStartError,
  type TranscriptsRuntimeContext,
} from "./capture.js";
import { hasSameTranscriptCaptureIntent } from "./config-reload.js";
import { resolveTranscriptsConfig, type ResolvedTranscriptsAutoStartConfig } from "./config.js";
import { beginConfiguredTranscriptStarts } from "./configured-start-status.js";
import type { TranscriptOccupancyWatchHandle, TranscriptSourceLocator } from "./provider-types.js";
import { sanitizeTranscriptSourceLocator } from "./source-locator.js";
import { transcriptSessionSelector, type TranscriptsStore } from "./store.js";

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
export function createTranscriptsAutoStartService(
  ctx: TranscriptsRuntimeContext,
  getConfig: () => OpenClawConfig | undefined = () => ctx.config,
): {
  start: () => void;
  stop: () => Promise<void>;
} {
  let stopped = false;
  let started = false;
  let diagnostics: ReturnType<typeof beginConfiguredTranscriptStarts> | undefined;
  const timers = new Set<Timer>();
  const watchers = new Set<TranscriptOccupancyWatchHandle>();
  const startedSessions = new Map<string, symbol>();
  const controllers = new Set<AbortController>();
  const pendingStarts = new Set<Promise<void>>();
  const pendingStops = new Set<Promise<void>>();
  const guildOwners = new Map<string, number>();
  const retries = new Map<number, ReturnType<typeof retainTranscriptStartRetry>>();
  const clearRetry = (index: number) => {
    retries.get(index)?.release();
    retries.delete(index);
  };
  const futureTitle = (entry: ResolvedTranscriptsAutoStartConfig, index: number) => {
    const latest = getConfig();
    return hasSameTranscriptCaptureIntent(ctx.config?.transcripts, latest?.transcripts)
      ? resolveTranscriptsConfig(latest?.transcripts).autoStart[index]?.title
      : entry.title;
  };
  const terminalDiagnostic = (error: unknown) =>
    error instanceof TranscriptStartError && !error.retry ? error.code : undefined;
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
  const forgetCapture = (capture: OwnedCapture) => {
    if (
      !ownsCapture(capture) &&
      startedSessions.get(capture.sessionId) === capture.lifecycleToken
    ) {
      startedSessions.delete(capture.sessionId);
    }
  };

  const stopCapture = async (capture: OwnedCapture, store: TranscriptsStore) => {
    const warnings: string[] = [];
    try {
      const active = activeSessions.get(capture.sessionId);
      if (!active || active.lifecycleToken !== capture.lifecycleToken) {
        forgetCapture(capture);
        return;
      }
      const details = await stopTranscriptCapture({
        ctx,
        store,
        selection: {
          session: active.session,
          selector: transcriptSessionSelector(active.session),
          activeCandidate: active,
          selectedActive: active,
          historicalRevision: undefined,
        },
      });
      if (details.status === "skipped") {
        return;
      }
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

  const startCapture = async (
    capture: OwnedCapture,
    index: number,
    params: Pick<
      Parameters<typeof startTranscripts>[0],
      "store" | "rawParams" | "abortSignal" | "existingSession" | "onCaptureEnded"
    >,
  ) => {
    diagnostics?.record(index, capture.lifecycleToken, "starting");
    try {
      const retry = retries.get(index);
      // Both modes validate the exact failed attempt immediately before the
      // configured start's synchronous existing-tuple write.
      retry?.assertCurrent(params.store);
      const result = await startTranscripts({
        ...params,
        existingSession: retry?.session ?? params.existingSession,
        ctx,
        startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
        configuredLifecycle: true,
        lifecycleToken: capture.lifecycleToken,
        rawParams: { ...params.rawParams, sessionId: capture.sessionId },
      });
      clearRetry(index);
      if (!stopped) {
        diagnostics?.record(
          index,
          capture.lifecycleToken,
          result.status === "ended" ? "ended" : undefined,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof TranscriptStartError) {
        clearRetry(index);
        if (!stopped && error.retry) {
          retries.set(index, retainTranscriptStartRetry(ctx, error.retry));
        }
      }
      throw error;
    } finally {
      // Shutdown may finish before startup transfers a cleanup/finalization owner.
      // Reconcile this exact attempt on every settlement, including rejected starts.
      if (ownsCapture(capture)) {
        startedSessions.set(capture.sessionId, capture.lifecycleToken);
        if (stopped) {
          await stopCapture(capture, params.store);
        }
      }
    }
  };

  const startContinuous = (
    entry: ResolvedTranscriptsAutoStartConfig,
    index: number,
    attempt: number,
    store: TranscriptsStore,
  ) => {
    if (stopped || startedSessions.has(entry.sessionId ?? "")) {
      return;
    }
    const capture: OwnedCapture = {
      sessionId:
        retries.get(index)?.session.sessionId ?? entry.sessionId ?? createTranscriptSessionId(),
      lifecycleToken: Symbol(entry.sessionId),
    };
    void runPending(async (controller) => {
      try {
        await startCapture(capture, index, {
          store,
          abortSignal: controller.signal,
          rawParams: { ...entry, title: futureTitle(entry, index) },
        });
      } catch (error) {
        if (stopped) {
          return;
        }
        // Only the exact failed provider attempt may retain retry authority.
        const terminal = terminalDiagnostic(error);
        if (terminal || attempt >= AUTO_START_RETRY_ATTEMPTS) {
          clearRetry(index);
          const diagnostic = terminal ?? "start-failed";
          diagnostics?.record(index, capture.lifecycleToken, diagnostic);
          ctx.logger.warn(
            `transcripts autoStart source ${index + 1}: ${diagnostic}. Check Meeting capture health in Settings.`,
          );
        } else {
          diagnostics?.record(index, capture.lifecycleToken, "retrying");
          schedule(() => startContinuous(entry, index, attempt + 1, store), AUTO_START_RETRY_MS);
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
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let startController: AbortController | undefined;
    let emptyTimer: Timer | undefined;
    let retryTimer: Timer | undefined;
    let source: TranscriptSourceLocator;
    let diagnosticToken = Symbol(`transcripts occupancy ${index}`);
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
      const terminal = terminalDiagnostic(error);
      if (terminal || attempt >= AUTO_START_RETRY_ATTEMPTS) {
        clearRetry(index);
        diagnostics?.record(index, diagnosticToken, terminal ?? "start-failed");
        ctx.logger.warn(
          `${label} failed: ${formatAutoStopDiagnostic(error)}; check the entry and provider connection. ${phase === "watch" ? "Restart the gateway to retry occupancy watching." : "Waiting for the next occupancy transition."}`,
        );
        return;
      }
      diagnostics?.record(index, diagnosticToken, "retrying");
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
          if (capture) {
            await stopCapture(capture, store);
            if (ownsCapture(capture)) {
              throw new Error("previous capture still awaits finalization");
            }
          }
          if (stopped || !occupied || controller.signal.aborted) {
            return;
          }
          const now = Date.now();
          const recent =
            retries.get(index)?.session ??
            store.readRecentStoppedSession(
              sanitizeTranscriptSourceLocator(source),
              new Date(now - AUTO_START_OCCUPANCY_REOPEN_WINDOW_MS).toISOString(),
              new Date(now).toISOString(),
            );
          const candidate =
            recent &&
            (!(source.agentId ?? ctx.agentId) ||
              (recent.metadata?.agentId ?? "main") === (source.agentId ?? ctx.agentId)) &&
            !activeSessions.has(recent.sessionId) &&
            !isTranscriptSessionStarting(recent.sessionId) &&
            !startedSessions.has(recent.sessionId)
              ? recent
              : undefined;
          const owned = {
            sessionId: candidate?.sessionId ?? createTranscriptSessionId(),
            lifecycleToken: Symbol(label),
          };
          diagnosticToken = owned.lifecycleToken;
          capture = owned;
          const result = await startCapture(owned, index, {
            store,
            abortSignal: controller.signal,
            existingSession: candidate,
            rawParams: {
              ...entry,
              ...source,
              title: futureTitle(entry, index),
            },
            onCaptureEnded: () => {
              if (capture !== owned || stopped || !occupied) {
                return;
              }
              forgetCapture(owned);
              cancel(retryTimer);
              retryTimer = schedule(() => begin(1), AUTO_START_RETRY_MS);
            },
          });
          if (result.status === "ended") {
            throw new Error("capture ended during startup");
          }
        } catch (error) {
          if (capture && !ownsCapture(capture)) {
            capture = undefined;
          }
          if (occupied && !controller.signal.aborted) {
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
        // Failed startup may restore its candidate while settling. A new
        // occupancy episode must consult the durable reopen window again.
        clearRetry(index);
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
          const provider = resolveSourceProvider(entry.providerId, ctx);
          if (!provider) {
            throw new Error("provider is not available");
          }
          if (!provider.watchOccupancy) {
            ctx.logger.warn(
              `${label} cannot report occupancy; remove whenOccupied or select a provider that supports occupancy watching.`,
            );
            return;
          }
          clearRetry(index);
          source = resolveTranscriptSourceOwnership({
            ctx,
            operation: "start",
            provider,
            source: { ...sourceFromParams(entry), providerId: provider.id },
            configuredLifecycle: true,
          }).source;
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
              clearRetry(index);
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
      diagnostics = beginConfiguredTranscriptStarts(ctx.config?.transcripts);
      const config = resolveTranscriptsConfig(ctx.config?.transcripts);
      if (!config.enabled || !config.autoStart.length) {
        return;
      }
      const store = createTranscriptsStore(ctx);
      for (const [index, entry] of config.autoStart.entries()) {
        if (entry.whenOccupied) {
          watchEntry(entry, index, store);
        } else {
          startContinuous(entry, index, 1, store);
        }
      }
    },
    async stop() {
      stopped = true;
      for (const index of retries.keys()) {
        clearRetry(index);
      }
      diagnostics?.clear();
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
      const store = createTranscriptsStore(ctx);
      for (const [sessionId, lifecycleToken] of startedSessions) {
        await stopCapture({ sessionId, lifecycleToken }, store);
      }
    },
  };
}
