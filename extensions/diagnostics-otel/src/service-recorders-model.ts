import { SpanStatusCode } from "@opentelemetry/api";
import { redactSensitiveText } from "../api.js";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { lowCardinalityAttr } from "./service-attributes.js";
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
    takeTrackedTrustedSpan,
    setSpanAttrs,
    contentCapturePolicy,
    tracesEnabled,
  } = runtime;

  const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
    "openclaw.provider": evt.provider,
    "openclaw.model": evt.model,
    "openclaw.api": lowCardinalityAttr(evt.api),
    "openclaw.transport": lowCardinalityAttr(evt.transport),
    "openclaw.model_call.observation_unit": modelCallObservationUnit(evt),
  });
  const genAiModelCallMetricAttrs = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => ({
    "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
    "gen_ai.provider.name": lowCardinalityAttr(evt.provider),
    "gen_ai.request.model": lowCardinalityAttr(evt.model),
    ...(errorType ? { "error.type": errorType } : {}),
  });
  const recordGenAiModelCallDuration = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => {
    genAiOperationDurationHistogram.record(
      evt.durationMs / 1000,
      genAiModelCallMetricAttrs(evt, errorType),
    );
  };
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
      return;
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
    trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
    );
  };

  const recordModelCallCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const metricAttrs = modelCallMetricAttrs(evt);
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt);
    if (!tracesEnabled) {
      return;
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
    span.end(evt.ts);
  };

  const recordModelCallError = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const errorType = lowCardinalityAttr(evt.errorCategory, "other");
    const metricAttrs = {
      ...modelCallMetricAttrs(evt),
      "openclaw.errorCategory": errorType,
      ...(evt.failureKind
        ? { "openclaw.failureKind": lowCardinalityAttr(evt.failureKind, "other") }
        : {}),
    };
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt, errorType);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
      "openclaw.errorCategory": errorType,
      "error.type": errorType,
    };
    if (evt.failureKind) {
      spanAttrs["openclaw.failureKind"] = lowCardinalityAttr(evt.failureKind, "other");
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
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: redactSensitiveText(evt.errorCategory),
    });
    span.end(evt.ts);
  };

  return {
    recordModelCallSizeTimingMetrics,
    recordModelCallStarted,
    recordModelCallCompleted,
    recordModelCallError,
  };
}
