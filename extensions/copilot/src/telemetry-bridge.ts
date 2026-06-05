// Copilot plugin module implements telemetry bridge behavior.
import type { CopilotClientOptions } from "@github/copilot-sdk";

// Telemetry bridge for the GitHub Copilot agent runtime.
//
// SDK surface:
//   - `CopilotClientOptions.telemetry?: TelemetryConfig` — OpenTelemetry
//     configuration applied to the spawned CLI process via env vars.
//   - `CopilotClientOptions.onGetTraceContext?: TraceContextProvider` —
//     async callback returning a W3C `{traceparent?, tracestate?}` that the
//     SDK injects into `session.create`, `session.resume`, and
//     `session.send` RPCs for distributed trace propagation.
//
// Host-side back-pointers (NOT imported here to keep the package boundary
// clean — the wiring layer injects these via callbacks):
//   - `src/infra/diagnostic-trace-context.ts` — `getActiveDiagnosticTraceContext`,
//     `formatDiagnosticTraceparent`, `DiagnosticTraceContext`.
//   - `src/infra/diagnostic-events.ts` — `formatDiagnosticTraceparentForPropagation`
//     for trusted-only propagation.
//
// IMPORTANT — pool reuse caveat:
//   `CopilotClientPool` keys on `{agentId, copilotHome, authMode,
//   authProfileId, authProfileVersion}`. Client-level telemetry and
//   `onGetTraceContext` are NOT part of the pool key. Two callers that
//   share a pool key but supply different telemetry options will get the
//   first-acquire's options ("first wins"). Mitigation:
//     - The trace-context provider returned by `createTraceContextProvider`
//       reads the active context **on every invocation**, so even when the
//       provider function is cached the propagated `traceparent` reflects
//       the current scope at RPC time. Per-call accuracy is preserved.
//     - `TelemetryConfig` (OTel env vars) is genuinely first-wins because
//       the CLI subprocess is spawned once per pool entry. Wire telemetry
//       as a process-wide / per-agent setting, not per-attempt.

type SdkTraceContext = NonNullable<
  Awaited<ReturnType<NonNullable<CopilotClientOptions["onGetTraceContext"]>>>
>;
type SdkTraceContextProvider = NonNullable<CopilotClientOptions["onGetTraceContext"]>;
type SdkTelemetryConfig = NonNullable<CopilotClientOptions["telemetry"]>;

export type { SdkTraceContext as CopilotTraceContext };
export type { SdkTelemetryConfig as CopilotTelemetryConfig };

export type CopilotTraceContextSource = () =>
  | SdkTraceContext
  | undefined
  | Promise<SdkTraceContext | undefined>;
export type CopilotTraceparentSource = () => string | undefined | Promise<string | undefined>;
export type CopilotTracestateSource = () => string | undefined | Promise<string | undefined>;

export interface CopilotTraceContextErrorInfo {
  readonly part: "traceContext" | "traceparent" | "tracestate";
  readonly error: Error;
}

export interface CopilotTraceContextOptions {
  /**
   * Primary source: a single callback returning the full SDK trace context
   * (`{traceparent?, tracestate?}`). Use this when the host has one
   * authoritative source of trace context so that traceparent and tracestate
   * always reflect the same logical scope.
   */
  getTraceContext?: CopilotTraceContextSource;
  /**
   * Convenience source: returns just the W3C `traceparent` header. Used
   * when {@link getTraceContext} is not supplied OR returns undefined.
   */
  getTraceparent?: CopilotTraceparentSource;
  /**
   * Convenience source: returns the W3C `tracestate` header. Only used
   * when {@link getTraceContext} is not supplied AND a non-empty
   * `traceparent` was obtained via {@link getTraceparent}. (Per W3C,
   * `tracestate` is meaningless without an accompanying `traceparent`.)
   */
  getTracestate?: CopilotTracestateSource;
  /**
   * Notifier for errors thrown by any source. Defaults to `console.warn`.
   * Notifier failures are themselves swallowed.
   */
  onError?: (info: CopilotTraceContextErrorInfo) => void;
}

const EMPTY_TRACE_CONTEXT: SdkTraceContext = Object.freeze({}) as SdkTraceContext;

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function defaultOnTraceContextError(info: CopilotTraceContextErrorInfo): void {
  console.warn(`[copilot:telemetry-bridge] ${info.part} source failed: ${info.error.message}`);
}

function safeNotify(
  notifier: (info: CopilotTraceContextErrorInfo) => void,
  info: CopilotTraceContextErrorInfo,
): void {
  try {
    notifier(info);
  } catch {
    // Notifier failures are swallowed: telemetry is best-effort.
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Build a TraceContextProvider suitable for `CopilotClientOptions.onGetTraceContext`.
 *
 * Resolution order on each invocation:
 *   1. If `getTraceContext` is supplied and returns a non-undefined value,
 *      return it as-is. Errors from this source → return `{}` and notify.
 *   2. Otherwise call `getTraceparent` (if supplied). On error → return
 *      `{}` and notify (no traceparent = no propagation).
 *   3. If traceparent is non-empty, call `getTracestate` (if supplied)
 *      and attach the result. Errors on tracestate are partial-success:
 *      notify and return `{traceparent}` (do not lose the parent).
 *   4. If no source provided OR all return undefined, return `{}` so the
 *      SDK behaves as if no provider were configured.
 */
export function createTraceContextProvider(
  options?: CopilotTraceContextOptions,
): SdkTraceContextProvider {
  const onError = options?.onError ?? defaultOnTraceContextError;
  const getTraceContext = options?.getTraceContext;
  const getTraceparent = options?.getTraceparent;
  const getTracestate = options?.getTracestate;

  return async () => {
    if (getTraceContext) {
      try {
        const ctx = await getTraceContext();
        if (ctx !== undefined) {
          return ctx;
        }
      } catch (error) {
        safeNotify(onError, { part: "traceContext", error: toError(error) });
        return EMPTY_TRACE_CONTEXT;
      }
    }

    if (!getTraceparent) {
      return EMPTY_TRACE_CONTEXT;
    }

    let traceparent: string | undefined;
    try {
      traceparent = await getTraceparent();
    } catch (error) {
      safeNotify(onError, { part: "traceparent", error: toError(error) });
      return EMPTY_TRACE_CONTEXT;
    }
    if (!isNonEmptyString(traceparent)) {
      return EMPTY_TRACE_CONTEXT;
    }

    if (!getTracestate) {
      return { traceparent } as SdkTraceContext;
    }

    let tracestate: string | undefined;
    try {
      tracestate = await getTracestate();
    } catch (error) {
      safeNotify(onError, { part: "tracestate", error: toError(error) });
      return { traceparent } as SdkTraceContext;
    }

    return isNonEmptyString(tracestate)
      ? ({ traceparent, tracestate } as SdkTraceContext)
      : ({ traceparent } as SdkTraceContext);
  };
}

export interface CopilotTelemetryOptions {
  otlpEndpoint?: string;
  filePath?: string;
  exporterType?: string;
  sourceName?: string;
  captureContent?: boolean;
}

/**
 * Shape a `TelemetryConfig` for `CopilotClientOptions.telemetry`. Returns
 * `undefined` when no fields are supplied so callers can spread
 * conditionally without producing an empty telemetry object that would
 * still partially configure the CLI's OTel env layout.
 *
 * Any explicitly-set value (including `false` for `captureContent`) is
 * preserved — only `undefined` is treated as "no opinion".
 */
export function createTelemetryConfig(
  options?: CopilotTelemetryOptions,
): SdkTelemetryConfig | undefined {
  if (!options) {
    return undefined;
  }
  const result: SdkTelemetryConfig = {};
  if (options.otlpEndpoint !== undefined) {
    result.otlpEndpoint = options.otlpEndpoint;
  }
  if (options.filePath !== undefined) {
    result.filePath = options.filePath;
  }
  if (options.exporterType !== undefined) {
    result.exporterType = options.exporterType;
  }
  if (options.sourceName !== undefined) {
    result.sourceName = options.sourceName;
  }
  if (options.captureContent !== undefined) {
    result.captureContent = options.captureContent;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
