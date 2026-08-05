// Diagnostics Otel API module exposes the plugin public contract.
import type { DiagnosticEventPayload as PublicDiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

type InternalDiagnosticEvent = {
  seq: number;
  ts: number;
  type: "session.maintenance.pruned";
  pruned: number;
  retentionMs: number;
};

export type DiagnosticEventPayload = PublicDiagnosticEventPayload | InternalDiagnosticEvent;

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
