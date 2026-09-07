import { SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "../api.js";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import {
  addUpstreamRequestIdSpanEvent,
  assignGenAiModelCallAttrs,
  assignModelCallPromptStatsAttrs,
  assignModelCallSizeTimingAttrs,
  assignModelCallUsageAttrs,
  genAiOperationName,
  modelCallSpanKind,
  modelCallSpanName,
  modelCallObservationUnit,
  positiveFiniteNumber,
} from "./service-genai-attributes.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { OtelModelCallContent } from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

export function createModelRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    genAiOperationDurationHistogram,
    modelCallDurationHistogram,
    modelCallRequestBytesHistogram,
    modelCallResponseBytesHistogram,
    modelCallTimeToFirstByteHistogram,
    spanWithDuration,
    activeTrustedParentContext,
    trackTrustedSpan,
    getTrackedInternalOrTrustedSpan,
    takeTrackedTrustedSpan,
    setSpanAttrs,
    contentCapturePolicy,
    tracesEnabled,
  } = runtime;

  const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
    "openclaw.provider": evt.provider,
    "openclaw.model": evt.model,
    "openclaw.api": normalizeDiagnosticValue(evt.api),
    "openclaw.transport": normalizeDiagnosticValue(evt.transport),
    "openclaw.model_call.observation_unit": modelCallObservationUnit(evt),
  });
  const recordModelCallSizeTimingMetrics = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
    attrs: ReturnType<typeof modelCallMetricAttrs>,
  ) => {
    const requestPayloadBytes = positiveFiniteNumber(evt.requestPayloadBytes);
    if (requestPayloadBytes !== undefined) {
      modelCallRequestBytesHistogram.record(requestPayloadBytes, attrs);
    }
    const responseStreamBytes = positiveFiniteNumber(evt.responseStreamBytes);
    if (responseStreamBytes !== undefined) {
      modelCallResponseBytesHistogram.record(responseStreamBytes, attrs);
    }
    const timeToFirstByteMs = positiveFiniteNumber(evt.timeToFirstByteMs);
    if (timeToFirstByteMs !== undefined) {
      modelCallTimeToFirstByteHistogram.record(timeToFirstByteMs, attrs);
    }
  };

  const recordModelCallStarted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled || !metadata.trusted) {
      return undefined;
    }
    const trackedSpan = getTrackedInternalOrTrustedSpan(evt, metadata);
    if (trackedSpan) {
      return trackedSpan.spanContext();
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
    };
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["openclaw.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["openclaw.transport"] = evt.transport;
    }
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    return trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
    ).spanContext();
  };

  const recordModelCallFinished = (
    evt: ModelCallLifecycleDiagnosticEvent,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const errorType =
      evt.type === "model.call.error"
        ? normalizeDiagnosticValue(evt.errorCategory, "other")
        : undefined;
    const metricAttrs = {
      ...modelCallMetricAttrs(evt),
      ...(errorType !== undefined ? { "openclaw.errorCategory": errorType } : {}),
      ...(evt.type === "model.call.error" && evt.failureKind
        ? { "openclaw.failureKind": normalizeDiagnosticValue(evt.failureKind, "other") }
        : {}),
    };
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    genAiOperationDurationHistogram.record(evt.durationMs / 1000, {
      "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
      "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
      "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
      ...(errorType ? { "error.type": errorType } : {}),
    });
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
      ...(errorType !== undefined
        ? { "openclaw.errorCategory": errorType, "error.type": errorType }
        : {}),
    };
    if (evt.type === "model.call.error" && evt.failureKind) {
      spanAttrs["openclaw.failureKind"] = normalizeDiagnosticValue(evt.failureKind, "other");
    }
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["openclaw.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["openclaw.transport"] = evt.transport;
    }
    assignModelCallSizeTimingAttrs(spanAttrs, evt);
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    assignModelCallUsageAttrs(spanAttrs, evt);
    assignOtelModelContentAttributes(spanAttrs, modelContent, contentCapturePolicy);
    const span =
      takeTrackedTrustedSpan(evt, metadata) ??
      spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
    if (evt.type === "model.call.error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactSensitiveText(evt.errorCategory),
      });
    }
    span.end(evt.ts);
  };

  return {
    recordModelCallStarted,
    recordModelCallFinished,
  };
}
