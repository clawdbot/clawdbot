// Diagnostic flag/event helpers for plugins that want narrow runtime gating.

export { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
export {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
export type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "../infra/diagnostic-trace-context.js";
