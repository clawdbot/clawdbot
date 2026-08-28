// OTEL adapter for the continuation-tracer surface. It is consumed only by
// `service.ts`:
//   - `service.ts::start()` — after `sdk.start()` succeeds, install the
//     adapter via `setContinuationTracer(createContinuationOtelTracerAdapter())`
//     so the existing `emitContinuation*Span` helpers emit real spans through
//     the OTEL SDK instead of into `noopTracer`.
//   - `service.ts::stopStarted()` — call `resetContinuationTracer()` so
//     the runtime returns to the additive no-op contract when the plugin shuts
//     down.
//
// Span parenting:
//   Same-process spans use the currently active OTEL context. Deferred or
//   cross-process hops carry a W3C `traceparent` on `StartSpanOptions`; the
//   continuation substrate lifts it onto `SystemEvent.traceparent` and
//   `QueuedSessionDeliveryPayloadMetadata`. This adapter reconstructs that
//   parent with the same `parseDiagnosticTraceparent` helper that powers the
//   auto-instrumented spans (`service.ts::contextForTraceContext`), keeping the
//   continuation chain on one trace with the correct parent span.

import {
  context as otelContextApi,
  isSpanContextValid,
  trace,
  SpanStatusCode,
  TraceFlags,
  type Context,
  type Attributes as OtelAttributes,
  type AttributeValue as OtelAttributeValue,
  type Span as OtelSpan,
  type SpanContext,
  type SpanOptions as OtelSpanOptions,
  type TracerProvider as OtelTracerProvider,
} from "@opentelemetry/api";
import {
  parseDiagnosticTraceparent,
  type ContinuationSpan,
  type ContinuationSpanAttributes,
  type ContinuationSpanStatus,
  type ContinuationStartSpanOptions,
  type ContinuationTracer,
  type DiagnosticTraceContext,
} from "../api.js";

/**
 * OTEL tracer name used for the continuation adapter.
 *
 * Distinguished from the `"openclaw"` tracer used by the auto-instrumented
 * spans in `service.ts` so collector/Tempo queries can filter on
 * `instrumentation.scope.name="openclaw.continuation"` to isolate the
 * continuation chain-correlation spans from the per-tool/per-exec/per-model
 * auto-instrumentation.
 */
export const CONTINUATION_OTEL_TRACER_NAME = "openclaw.continuation";

type ContinuationOtelTracerAdapterOptions = {
  tracerProvider?: Pick<OtelTracerProvider, "getTracer">;
  resolveParentContext?: (traceContext: DiagnosticTraceContext) => Context | undefined;
  resolveSpanContext?: (traceContext: DiagnosticTraceContext) => SpanContext | undefined;
};

function diagnosticTraceFlagsToOtel(flags: string | undefined): TraceFlags {
  const parsed = Number.parseInt(flags ?? "00", 16);
  return (parsed & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE;
}

function otelTraceFlagsToDiagnostic(flags: TraceFlags | undefined): string {
  return ((flags ?? TraceFlags.NONE) & TraceFlags.SAMPLED) !== 0 ? "01" : "00";
}

function continuationStatusToOtel(status: ContinuationSpanStatus): SpanStatusCode {
  switch (status) {
    case "OK":
      return SpanStatusCode.OK;
    case "ERROR":
      return SpanStatusCode.ERROR;
    default:
      return SpanStatusCode.UNSET;
  }
}

function spanAttributesToOtel(
  attrs: ContinuationSpanAttributes | undefined,
): OtelAttributes | undefined {
  if (!attrs) {
    return undefined;
  }
  // The continuation `SpanAttributeValue` superset (string | number |
  // boolean | readonly arrays thereof) is a strict subset of OTEL's
  // `AttributeValue` (which also accepts mutable arrays). Cast through
  // `OtelAttributeValue` per-key keeps the boundary type-safe — the
  // runtime values are already in the accepted set.
  const out: OtelAttributes = {};
  for (const key of Object.keys(attrs)) {
    // SAFETY: ContinuationSpanAttributes values are string|number|boolean|readonly arrays thereof, a strict subset of OTEL's AttributeValue; the cast only widens the accepted union.
    out[key] = attrs[key] as OtelAttributeValue;
  }
  return out;
}

function wrapOtelSpan(otelSpan: OtelSpan): ContinuationSpan {
  let ended = false;
  return {
    setAttributes(attrs: ContinuationSpanAttributes): void {
      const mapped = spanAttributesToOtel(attrs);
      if (mapped) {
        otelSpan.setAttributes(mapped);
      }
    },
    setStatus(status: ContinuationSpanStatus, message?: string): void {
      otelSpan.setStatus({
        code: continuationStatusToOtel(status),
        ...(message ? { message } : {}),
      });
    },
    recordException(err: unknown): void {
      if (err instanceof Error) {
        otelSpan.recordException(err);
        return;
      }
      otelSpan.recordException({
        name: "ContinuationException",
        message: typeof err === "string" ? err : String(err),
      });
    },
    traceparent(): string | undefined {
      const spanContext = otelSpan.spanContext();
      return `00-${spanContext.traceId}-${spanContext.spanId}-${otelTraceFlagsToDiagnostic(
        spanContext.traceFlags,
      )}`;
    },
    end(): void {
      // Idempotent end matches the continuation `Span` contract:
      //   "End the span. Idempotent: subsequent calls are no-ops."
      // The OTEL SDK's own `Span.end()` is also documented as idempotent
      // in practice but the guard is cheap and contractually-required.
      if (ended) {
        return;
      }
      ended = true;
      otelSpan.end();
    },
  };
}

/**
 * Build the OTEL adapter. The returned tracer conforms to the
 * `ContinuationTracer` shape exported from
 * `openclaw/plugin-sdk/diagnostic-runtime` and is suitable for
 * registering via `setContinuationTracer(...)`.
 */
export function createContinuationOtelTracerAdapter(
  adapterOptions: ContinuationOtelTracerAdapterOptions = {},
): ContinuationTracer {
  const otelTracer =
    adapterOptions.tracerProvider?.getTracer(CONTINUATION_OTEL_TRACER_NAME) ??
    trace.getTracer(CONTINUATION_OTEL_TRACER_NAME);
  return {
    formatTraceparent(traceContext: DiagnosticTraceContext): string | undefined {
      // Continuation hops serialize this traceparent onto durable records
      // (`SystemEvent.traceparent`, queued delivery metadata) and rebuild the
      // parent from it on re-entry, so returning nothing permanently orphans
      // the far side of a `continue_delegate`/`continue_work` boundary.
      //
      // The trusted-span registry is a process-local accelerator: it is keyed
      // by OpenClaw's diagnostic trace id, is capacity-evicted, and cannot
      // survive a restart or a second process. Prefer its exact mapping when
      // present, then fall back to the SDK's live active span, which is the
      // authoritative "where we came from" for a real exported span.
      const spanContext =
        adapterOptions.resolveSpanContext?.(traceContext) ??
        trace.getSpanContext(otelContextApi.active());
      if (!spanContext || !isSpanContextValid(spanContext)) {
        return undefined;
      }
      return `00-${spanContext.traceId}-${spanContext.spanId}-${otelTraceFlagsToDiagnostic(
        spanContext.traceFlags,
      )}`;
    },
    startSpan(name: string, options?: ContinuationStartSpanOptions): ContinuationSpan {
      const otelOpts: OtelSpanOptions = {};
      const mappedAttrs = spanAttributesToOtel(options?.attributes);
      if (mappedAttrs) {
        otelOpts.attributes = mappedAttrs;
      }

      // Parent-stitch via traceparent when the caller carried one through the
      // continuation hop.
      if (options?.traceparent) {
        const parsed: DiagnosticTraceContext | undefined = parseDiagnosticTraceparent(
          options.traceparent,
        );
        if (parsed?.spanId && parsed.traceId) {
          const resolvedSpanContext = adapterOptions.resolveSpanContext?.(parsed);
          const parentCtx =
            adapterOptions.resolveParentContext?.(parsed) ??
            (resolvedSpanContext
              ? trace.setSpanContext(otelContextApi.active(), resolvedSpanContext)
              : undefined) ??
            trace.setSpanContext(otelContextApi.active(), {
              traceId: parsed.traceId,
              spanId: parsed.spanId,
              traceFlags: diagnosticTraceFlagsToOtel(parsed.traceFlags),
              isRemote: true,
            });
          return wrapOtelSpan(otelTracer.startSpan(name, otelOpts, parentCtx));
        }
      }

      return wrapOtelSpan(otelTracer.startSpan(name, otelOpts, otelContextApi.active()));
    },
  };
}
