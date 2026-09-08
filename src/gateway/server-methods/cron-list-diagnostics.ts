import { performance } from "node:perf_hooks";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type Phase = "setup" | "listing" | "projection" | "previews" | "response" | "handlerExit";
type RequestMode = { compact: boolean; previewsRequested: boolean; scopeApplied: boolean };
export type CronListDiagnostics = NonNullable<ReturnType<typeof startCronListDiagnostics>>;

export function startCronListDiagnostics(
  log: Pick<GatewayRequestContext["logGateway"], "warn">,
  respond: RespondFn,
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  // Share each raw checkpoint with the tracker before its display-only rounding.
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  let phase: Phase = "setup";
  let phaseStartedAt = checkpoint;
  let listingMs = 0;
  let sourcePageMs = 0;
  let sourcePageCount = 0;
  let scopeAttemptCount = 0;
  let returnedCount: number | undefined;
  let requestMode: RequestMode | undefined;
  let responseOutcome: "none" | "ok" | "error" | "threw" = "none";
  let finished = false;
  const mark = (nextPhase: Phase) => {
    if (finished) {
      return;
    }
    checkpoint = performance.now();
    timing.mark(phase);
    if (phase === "listing") {
      listingMs = checkpoint - phaseStartedAt;
    }
    phase = nextPhase;
    phaseStartedAt = checkpoint;
  };
  return {
    mark,
    setRequestMode(mode: RequestMode) {
      requestMode = mode;
    },
    setReturnedCount(count: number) {
      returnedCount = count;
    },
    startScopeAttempt() {
      scopeAttemptCount++;
    },
    startSourcePage() {
      sourcePageCount++;
      const pageStartedAt = performance.now();
      return () => {
        sourcePageMs += performance.now() - pageStartedAt;
      };
    },
    respond: ((...args) => {
      mark("response");
      responseOutcome = args[0] ? "ok" : "error";
      try {
        return respond(...args);
      } catch (error) {
        responseOutcome = "threw";
        throw error;
      } finally {
        mark("handlerExit");
      }
    }) satisfies RespondFn,
    finish(handlerOutcome: "returned" | "threw") {
      if (finished) {
        return;
      }
      mark("handlerExit");
      finished = true;
      const elapsedMs = checkpoint - startedAt;
      if (elapsedMs < 1_000 || !areDiagnosticsEnabledForProcess()) {
        return;
      }
      try {
        runWithDiagnosticTraceContext(trace, () =>
          log.warn("cron: slow list request", {
            operation: "cron.list",
            elapsedMs: Math.round(elapsedMs),
            phaseDurationsMs: Object.fromEntries(
              timing.snapshot().stages.map((stage) => [stage.name, stage.durationMs]),
            ),
            sourcePageMs: Math.round(sourcePageMs),
            sourcePageCount,
            scopeAttemptCount,
            ...(returnedCount === undefined ? {} : { returnedCount }),
            ...(requestMode?.scopeApplied
              ? { scopeProcessingMs: Math.round(listingMs - sourcePageMs) }
              : {}),
            ...requestMode,
            handlerOutcome,
            responseOutcome,
          }),
        );
      } catch {
        // Diagnostic failures cannot replace the handler's response or original error.
      }
    },
  };
}
