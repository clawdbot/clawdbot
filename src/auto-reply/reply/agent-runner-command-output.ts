import {
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { GetReplyOptions } from "../types.js";

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return readFiniteNumberValue(value);
}

function isCommandToolName(name: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return normalized === "exec" || normalized === "bash" || normalized === "shell";
}

/** Projects a completed command-tool event into the channel command-output contract. */
export function buildCommandOutputFromToolResultEvent(evt: {
  stream: string;
  data: Record<string, unknown>;
}): Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0] | undefined {
  if (evt.stream !== "tool" || readStringValue(evt.data.phase) !== "result") {
    return undefined;
  }
  const name = readStringValue(evt.data.name);
  if (!isCommandToolName(name)) {
    return undefined;
  }
  const result = readRecordValue(evt.data.result);
  const details = readRecordValue(result?.details);
  const output =
    readStringValue(evt.data.output) ??
    readStringValue(result?.output) ??
    readStringValue(details?.output);
  const explicitStatus =
    readStringValue(evt.data.status) ??
    readStringValue(result?.status) ??
    readStringValue(details?.status);
  const exitCode = readNullableNumberValue(
    result?.exitCode ?? details?.exitCode ?? evt.data.exitCode,
  );
  const durationMs = readFiniteNumberValue(
    result?.durationMs ?? details?.durationMs ?? evt.data.durationMs,
  );
  const cwd = readStringValue(evt.data.cwd);
  const hasConcreteCommandResult =
    output !== undefined ||
    explicitStatus !== undefined ||
    exitCode !== undefined ||
    durationMs !== undefined ||
    cwd !== undefined ||
    (result !== undefined && Object.keys(result).length > 0);
  if (!hasConcreteCommandResult) {
    return undefined;
  }
  const errorStatus =
    evt.data.isError === true ? "failed" : evt.data.isError === false ? "completed" : undefined;
  return {
    itemId: readStringValue(evt.data.itemId),
    phase: "end",
    title: readStringValue(evt.data.title),
    toolCallId: readStringValue(evt.data.toolCallId),
    name,
    output,
    status: explicitStatus ?? errorStatus,
    exitCode,
    durationMs,
    cwd,
  };
}
