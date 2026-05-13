import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveFieldValue,
  redactSensitiveText,
} from "../logging/redact.js";

function resolveTranscriptRedactPatterns(patterns?: string[]) {
  return patterns && patterns.length > 0 ? [...patterns, ...getDefaultRedactPatterns()] : undefined;
}

function redactTranscriptOptions(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const mode = cfg?.logging?.redactSensitive ?? configuredLogging?.redactSensitive;
  const patterns = resolveTranscriptRedactPatterns(
    cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns,
  );
  if (mode === undefined && patterns === undefined) {
    return undefined;
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(patterns !== undefined ? { patterns } : {}),
  };
}

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveFieldValue(key, value, redactTranscriptOptions(cfg));
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactTranscriptStructuredValue(
  value: unknown,
  cfg?: OpenClawConfig,
  fieldKey?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg);
    }
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(item, cfg, fieldKey, seen);
      changed ||= next !== item;
      return next;
    });
    seen.delete(value);
    return changed ? redacted : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (!isPlainTranscriptObject(value)) {
    return value;
  }

  seen.add(value);
  const source = value;
  let next: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(source)) {
    const redacted = redactTranscriptStructuredValue(item, cfg, key, seen);
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  seen.delete(value);
  return next ?? value;
}

export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  if (cfg?.logging?.redactSensitive === "off") {
    return message;
  }
  return redactTranscriptStructuredValue(message, cfg) as AgentMessage;
}
