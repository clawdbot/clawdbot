// Diagnostic flag/event helpers for plugins that want narrow runtime gating.

import { redactSensitiveText } from "../logging/redact.js";

const LOW_CARDINALITY_DIAGNOSTIC_VALUE_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;

export function normalizeDiagnosticValue(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  const redactedLower = redacted.toLowerCase();
  // Session-shaped agent identifiers are unbounded and must never become exporter dimensions.
  if (redactedLower.startsWith("agent:") || redactedLower.includes(":agent:")) {
    return fallback;
  }
  return LOW_CARDINALITY_DIAGNOSTIC_VALUE_RE.test(redacted) ? redacted : fallback;
}

export function normalizeDiagnosticLane(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  if (redacted.toLowerCase().startsWith("agent:")) {
    return fallback;
  }
  // Scoped lane suffixes carry session identity; exporters group only by the stable lane prefix.
  const scopedLaneIndex = redacted.indexOf(":");
  const lane = scopedLaneIndex >= 0 ? redacted.slice(0, scopedLaneIndex) : redacted;
  return LOW_CARDINALITY_DIAGNOSTIC_VALUE_RE.test(lane) ? lane : fallback;
}

export { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
  DiagnosticModelCallContent,
} from "../infra/diagnostic-events.js";
export type { DiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";
export {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
export { resolveDiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";
export type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "../infra/diagnostic-trace-context.js";
