// Narrow plugin-sdk surface for the bundled diagnostics-otel plugin.
// Keep this list additive and scoped to the bundled diagnostics-otel surface.

export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export type { DiagnosticEventMetadata } from "../infra/diagnostic-events.js";
export type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export { emitDiagnosticEvent, onDiagnosticEvent } from "../infra/diagnostic-events.js";
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "../infra/diagnostic-trace-context.js";
export { redactSensitiveText } from "../logging/redact.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../plugins/types.js";
