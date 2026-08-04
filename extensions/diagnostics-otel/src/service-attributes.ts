import type { LogRecord } from "@opentelemetry/api-logs";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload, DiagnosticTraceContext } from "../api.js";
import { redactSensitiveText } from "../api.js";
import {
  BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS,
  DROPPED_OTEL_ATTRIBUTE_KEYS,
  MAX_OTEL_LOG_ATTRIBUTE_COUNT,
  MAX_OTEL_LOG_ATTRIBUTE_VALUE_CHARS,
  OTEL_LOG_ATTRIBUTE_KEY_RE,
  OTEL_LOG_RAW_ATTRIBUTE_KEY_RE,
  SECURITY_TARGET_NAME_VALUE_RE,
} from "./service-constants.js";
import { normalizeOtelLogString } from "./service-content-normalization.js";
import type { OtelContentCapturePolicy } from "./service-content-normalization.js";
import type { SecuritySeverityText } from "./service-types.js";

export function redactOtelAttributes(attributes: Record<string, string | number | boolean>) {
  const redactedAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED_OTEL_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    redactedAttributes[key] = typeof value === "string" ? redactSensitiveText(value) : value;
  }
  return redactedAttributes;
}

function securityTargetNameAttr(value: string | undefined, fallback = "unknown"): string {
  if (!value) {
    return fallback;
  }
  const redacted = redactSensitiveText(value.trim());
  const redactedLower = redacted.toLowerCase();
  if (redactedLower.startsWith("agent:") || redactedLower.includes(":agent:")) {
    return fallback;
  }
  return SECURITY_TARGET_NAME_VALUE_RE.test(redacted) ? redacted : fallback;
}

export function shouldCaptureOtelLogBody(policy: OtelContentCapturePolicy): boolean {
  return policy.logBodies;
}

function otelLogTimestampIso(timestamp: LogRecord["timestamp"]): string {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (Array.isArray(timestamp)) {
    const [seconds, nanoseconds] = timestamp;
    if (Number.isFinite(seconds) && Number.isFinite(nanoseconds)) {
      return new Date(seconds * 1000 + Math.trunc(nanoseconds / 1_000_000)).toISOString();
    }
  }
  return new Date().toISOString();
}

export function writeStdoutDiagnosticLogRecord(params: {
  logRecord: LogRecord;
  serviceName: string;
  traceContext?: DiagnosticTraceContext;
}): void {
  const { logRecord, serviceName, traceContext } = params;
  const line = {
    ts: otelLogTimestampIso(logRecord.timestamp),
    signal: "openclaw.diagnostic.log",
    "service.name": serviceName,
    severityText: logRecord.severityText,
    severityNumber: logRecord.severityNumber,
    body: logRecord.body,
    attributes: logRecord.attributes ?? {},
    ...(traceContext?.traceId ? { trace_id: traceContext.traceId } : {}),
    ...(traceContext?.spanId ? { span_id: traceContext.spanId } : {}),
    ...(traceContext?.traceFlags ? { trace_flags: traceContext.traceFlags } : {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function assignOtelLogAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean,
): void {
  if (Object.keys(attributes).length >= MAX_OTEL_LOG_ATTRIBUTE_COUNT) {
    return;
  }
  if (BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS.has(key)) {
    return;
  }
  if (redactSensitiveText(key) !== key) {
    return;
  }
  if (!OTEL_LOG_ATTRIBUTE_KEY_RE.test(key)) {
    return;
  }
  if (typeof value === "string") {
    attributes[key] = normalizeOtelLogString(value, MAX_OTEL_LOG_ATTRIBUTE_VALUE_CHARS);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[key] = value;
    return;
  }
  if (typeof value === "boolean") {
    attributes[key] = value;
  }
}

export function assignOtelLogEventAttributes(
  attributes: Record<string, string | number | boolean>,
  eventAttributes: Record<string, string | number | boolean> | undefined,
): void {
  if (!eventAttributes) {
    return;
  }
  for (const [rawKey, value] of Object.entries(eventAttributes)) {
    if (Object.keys(attributes).length >= MAX_OTEL_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    const key = rawKey.trim();
    if (BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    if (redactSensitiveText(key) !== key) {
      continue;
    }
    if (!OTEL_LOG_RAW_ATTRIBUTE_KEY_RE.test(key)) {
      continue;
    }
    assignOtelLogAttribute(attributes, `openclaw.${key}`, value);
  }
}

function assignOtelSecurityEventAttributes(
  attributes: Record<string, string | number | boolean>,
  eventAttributes: Record<string, string | number | boolean> | undefined,
): void {
  if (!eventAttributes) {
    return;
  }
  for (const [rawKey, value] of Object.entries(eventAttributes)) {
    if (Object.keys(attributes).length >= MAX_OTEL_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    const key = rawKey.trim();
    if (BLOCKED_OTEL_LOG_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }
    if (redactSensitiveText(key) !== key) {
      continue;
    }
    if (!OTEL_LOG_RAW_ATTRIBUTE_KEY_RE.test(key)) {
      continue;
    }
    assignOtelLogAttribute(
      attributes,
      `openclaw.security.attribute.${key}`,
      typeof value === "string" ? normalizeDiagnosticValue(value) : value,
    );
  }
}

export function securitySeverityText(
  severity: Extract<DiagnosticEventPayload, { type: "security.event" }>["severity"],
): SecuritySeverityText {
  switch (severity) {
    case "critical":
      return "FATAL";
    case "high":
      return "ERROR";
    case "medium":
      return "WARN";
    case "info":
    case "low":
      return "INFO";
  }
  const unreachable: never = severity;
  return unreachable;
}

export function assignOtelSecurityAttributes(
  attributes: Record<string, string | number | boolean>,
  evt: Extract<DiagnosticEventPayload, { type: "security.event" }>,
): void {
  assignOtelLogAttribute(attributes, "openclaw.security.event_id", evt.eventId);
  assignOtelLogAttribute(attributes, "openclaw.security.category", evt.category);
  assignOtelLogAttribute(
    attributes,
    "openclaw.security.action",
    normalizeDiagnosticValue(evt.action),
  );
  assignOtelLogAttribute(attributes, "openclaw.security.outcome", evt.outcome);
  assignOtelLogAttribute(attributes, "openclaw.security.severity", evt.severity);
  if (evt.reason) {
    assignOtelLogAttribute(
      attributes,
      "openclaw.security.reason",
      normalizeDiagnosticValue(evt.reason),
    );
  }
  if (evt.actor) {
    assignOtelLogAttribute(attributes, "openclaw.security.actor.kind", evt.actor.kind);
    if (evt.actor.idHash) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.actor.id_hash",
        normalizeDiagnosticValue(evt.actor.idHash),
      );
    }
    if (evt.actor.deviceIdHash) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.actor.device_id_hash",
        normalizeDiagnosticValue(evt.actor.deviceIdHash),
      );
    }
    if (evt.actor.channel) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.actor.channel",
        normalizeDiagnosticValue(evt.actor.channel),
      );
    }
    if (evt.actor.role) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.actor.role",
        normalizeDiagnosticValue(evt.actor.role),
      );
    }
    if (evt.actor.scopes?.length) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.actor.scopes",
        evt.actor.scopes.map((scope) => normalizeDiagnosticValue(scope)).join(","),
      );
    }
  }
  if (evt.target) {
    assignOtelLogAttribute(attributes, "openclaw.security.target.kind", evt.target.kind);
    if (evt.target.idHash) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.target.id_hash",
        normalizeDiagnosticValue(evt.target.idHash),
      );
    }
    if (evt.target.name) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.target.name",
        securityTargetNameAttr(evt.target.name),
      );
    }
    if (evt.target.owner) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.target.owner",
        normalizeDiagnosticValue(evt.target.owner),
      );
    }
  }
  if (evt.policy) {
    if (evt.policy.id) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.policy.id",
        normalizeDiagnosticValue(evt.policy.id),
      );
    }
    if (evt.policy.decision) {
      assignOtelLogAttribute(attributes, "openclaw.security.policy.decision", evt.policy.decision);
    }
    if (evt.policy.reason) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.policy.reason",
        normalizeDiagnosticValue(evt.policy.reason),
      );
    }
  }
  if (evt.control) {
    if (evt.control.id) {
      assignOtelLogAttribute(
        attributes,
        "openclaw.security.control.id",
        normalizeDiagnosticValue(evt.control.id),
      );
    }
    if (evt.control.family) {
      assignOtelLogAttribute(attributes, "openclaw.security.control.family", evt.control.family);
    }
  }
  assignOtelSecurityEventAttributes(attributes, evt.attributes);
}
