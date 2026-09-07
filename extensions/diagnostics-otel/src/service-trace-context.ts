import { context as otelContextApi, trace, TraceFlags } from "@opentelemetry/api";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticTraceContext,
} from "../api.js";
import {
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
} from "../api.js";

export function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

function traceFlagsToOtel(traceFlags: string | undefined): TraceFlags {
  const parsed = Number.parseInt(traceFlags ?? "00", 16);
  return (parsed & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE;
}

export function contextForTraceContext(traceContext: DiagnosticTraceContext | undefined) {
  const normalized = normalizeTraceContext(traceContext);
  if (!normalized?.spanId) {
    return undefined;
  }
  return trace.setSpanContext(otelContextApi.active(), {
    traceId: normalized.traceId,
    spanId: normalized.spanId,
    traceFlags: traceFlagsToOtel(normalized.traceFlags),
    isRemote: true,
  });
}

export function contextForTrustedTraceContext(
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
) {
  return metadata.trusted || metadata.trustedTraceContext === true
    ? contextForTraceContext(evt.trace)
    : undefined;
}

export function normalizedTrustedTraceContext(
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): DiagnosticTraceContext | undefined {
  return metadata.trusted || metadata.trustedTraceContext === true
    ? normalizeTraceContext(evt.trace)
    : undefined;
}

export function addTraceAttributes(
  attributes: Record<string, string | number | boolean>,
  traceContext: DiagnosticTraceContext | undefined,
): void {
  const normalized = normalizeTraceContext(traceContext);
  if (!normalized) {
    return;
  }
  attributes["openclaw.traceId"] = normalized.traceId;
  if (normalized.spanId) {
    attributes["openclaw.spanId"] = normalized.spanId;
  }
  if (normalized.parentSpanId) {
    attributes["openclaw.parentSpanId"] = normalized.parentSpanId;
  }
  if (normalized.traceFlags) {
    attributes["openclaw.traceFlags"] = normalized.traceFlags;
  }
}
