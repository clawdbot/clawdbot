// Diagnostics Prometheus API module exposes the plugin public contract.
import type { DiagnosticEventPayload as PublicDiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

export type DiagnosticEventPayload = PublicDiagnosticEventPayload;

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
