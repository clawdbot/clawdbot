// Diagnostics Prometheus API module exposes the plugin public contract.
import type { DiagnosticEventPayload as PublicDiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

type InternalDiagnosticEvent = {
  seq: number;
  ts: number;
  type: "session.maintenance.pruned";
  pruned: number;
  retentionMs: number;
};

export type DiagnosticEventPayload = PublicDiagnosticEventPayload | InternalDiagnosticEvent;

export type { DiagnosticEventMetadata } from "openclaw/plugin-sdk/diagnostic-runtime";
export { isInternalDiagnosticEventMetadata } from "openclaw/plugin-sdk/diagnostic-runtime";
export {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type OpenClawPluginHttpRouteHandler,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
