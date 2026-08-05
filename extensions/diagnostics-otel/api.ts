// Diagnostics Otel API module exposes the plugin public contract.
import type { DiagnosticEventPayload as PublicDiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type DiagnosticEventPayload = PublicDiagnosticEventPayload;

export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  onDiagnosticEvent,
  parseDiagnosticTraceparent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPrivateData,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
export { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
