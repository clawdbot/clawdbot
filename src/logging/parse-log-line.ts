import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Log line parsing helpers convert text log entries into structured records.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

// Parser for JSON LogTape lines emitted by the OpenClaw logger.
export type ParsedLogLine = {
  time?: string;
  level?: string;
  subsystem?: string;
  module?: string;
  plugin?: string;
  message: string;
  raw: string;
};
type LogContext = Pick<ParsedLogLine, "subsystem" | "module" | "plugin">;

function extractMessage(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    const item = value[key];
    if (typeof item === "string") {
      parts.push(item);
    } else if (item != null) {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join(" ");
}

function parseMetaName(raw?: unknown): LogContext {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      subsystem: typeof parsed.subsystem === "string" ? parsed.subsystem : undefined,
      module: typeof parsed.module === "string" ? parsed.module : undefined,
      plugin: typeof parsed.plugin === "string" ? parsed.plugin : undefined,
    };
  } catch {
    return {};
  }
}

function resolveContext(
  value: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): LogContext {
  const metadataContext = parseMetaName(meta?.name);
  const positionalContext = parseMetaName(value["0"]);
  return {
    subsystem: metadataContext.subsystem ?? positionalContext.subsystem,
    module: metadataContext.module ?? positionalContext.module,
    plugin: metadataContext.plugin ?? positionalContext.plugin,
  };
}

/** Parses a raw log line into compact metadata and message text, or null for non-JSON lines. */
export function parseLogLine(raw: string): ParsedLogLine | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const meta = isRecord(parsed["_meta"]) ? parsed["_meta"] : undefined;
    const context = resolveContext(parsed, meta);
    const levelRaw = typeof meta?.logLevelName === "string" ? meta.logLevelName : undefined;
    return {
      time:
        typeof parsed.time === "string"
          ? parsed.time
          : typeof meta?.date === "string"
            ? meta.date
            : undefined,
      level: normalizeOptionalLowercaseString(levelRaw),
      subsystem: context.subsystem,
      module: context.module,
      plugin: context.plugin,
      message: typeof parsed.message === "string" ? parsed.message : extractMessage(parsed),
      raw,
    };
  } catch {
    return null;
  }
}
