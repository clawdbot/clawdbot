// Diagnostics Otel API module exposes the plugin public contract.
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  formatDiagnosticTraceparent,
  getContinuationTracer,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  noopTracer,
  onDiagnosticEvent,
  parseDiagnosticTraceparent,
  resetContinuationTracer,
  setContinuationTracer,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  type DiagnosticTraceContext,
  type Span as ContinuationSpan,
  type SpanAttributes as ContinuationSpanAttributes,
  type SpanAttributeValue as ContinuationSpanAttributeValue,
  type SpanStatus as ContinuationSpanStatus,
  type StartSpanOptions as ContinuationStartSpanOptions,
  type Tracer as ContinuationTracer,
} from "openclaw/plugin-sdk/diagnostic-runtime";
export { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
