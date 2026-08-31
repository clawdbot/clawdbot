import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent, AgentOptions as HttpsAgentOptions } from "node:https";
import type { LogRecord } from "@opentelemetry/api-logs";
import type {
  DiagnosticEventPayload,
  DiagnosticTraceContext,
  OpenClawPluginServiceContext,
} from "../api.js";

export type OtelLogsExporter = "otlp" | "stdout" | "both";
type OtelHttpAgent = HttpAgent | HttpsAgent;
export type OtelHttpAgentFactory = (protocol: string) => OtelHttpAgent | Promise<OtelHttpAgent>;
export type OtelSignalIdentifier = "TRACES" | "METRICS" | "LOGS";
export type OtelHttpAgentOptions = HttpsAgentOptions & {
  keepAlive: true;
};
export type OtelLogger = OpenClawPluginServiceContext["logger"];

export type BuiltOtelLogRecord = {
  logRecord: LogRecord;
  traceContext?: DiagnosticTraceContext;
};

export type MessageDeliveryDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  {
    type: "message.delivery.started" | "message.delivery.completed" | "message.delivery.error";
  }
>;
export type ModelCallLifecycleDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.completed" | "model.call.error" }
>;
export type ModelFailoverDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.failover" }
>;
export type HarnessRunDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "harness.run.started" | "harness.run.completed" | "harness.run.error" }
>;
export type TelemetryExporterDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "telemetry.exporter" }
>;
export type SessionRecoveryDiagnosticEvent = Extract<
  DiagnosticEventPayload,
  { type: "session.recovery.requested" | "session.recovery.completed" }
>;
export type TalkDiagnosticEvent = Extract<DiagnosticEventPayload, { type: "talk.event" }>;
export type SecuritySeverityText = "FATAL" | "ERROR" | "WARN" | "INFO";
export type TrustedSpanAliasOwner = { kind: "run"; id: string };
