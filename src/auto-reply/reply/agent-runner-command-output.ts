import {
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { inferToolMetaFromArgs } from "../../agents/embedded-agent-utils.js";
import type { GetReplyOptions } from "../types.js";

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * CLI backends report a tool result as its raw content: a string, or the text
 * blocks the harness streamed. Structured runners send a record instead, so the
 * command projection has to read both or every CLI command result is dropped.
 */
function readToolResultText(value: unknown): string | undefined {
  const direct = readStringValue(value);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((block) => readStringValue(readRecordValue(block)?.text))
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .trim();
  return text || undefined;
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
  if (!name || !isCommandToolName(name)) {
    return undefined;
  }
  const result = readRecordValue(evt.data.result);
  const details = readRecordValue(result?.details);
  const output =
    readStringValue(evt.data.output) ??
    readStringValue(result?.output) ??
    readStringValue(details?.output) ??
    readToolResultText(evt.data.result);
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
  // A reported success/failure is a concrete outcome on its own. Requiring a
  // structured field first dropped every text-only CLI result, so a failed
  // command rendered exactly like one that succeeded.
  const errorStatus =
    evt.data.isError === true ? "failed" : evt.data.isError === false ? "completed" : undefined;
  const hasConcreteCommandResult =
    output !== undefined ||
    explicitStatus !== undefined ||
    errorStatus !== undefined ||
    exitCode !== undefined ||
    durationMs !== undefined ||
    cwd !== undefined ||
    (result !== undefined && Object.keys(result).length > 0);
  if (!hasConcreteCommandResult) {
    return undefined;
  }
  // Keep the line describing the command, not its output: without a title the
  // terminal line would replace the request with whatever the tool printed.
  const args = readRecordValue(evt.data.args);
  const title =
    readStringValue(evt.data.title) ??
    (args ? inferToolMetaFromArgs(name, args, { detailMode: "explain" }) : undefined);
  return {
    itemId: readStringValue(evt.data.itemId),
    phase: "end",
    title,
    toolCallId: readStringValue(evt.data.toolCallId),
    name,
    output,
    status: explicitStatus ?? errorStatus,
    exitCode,
    durationMs,
    cwd,
  };
}
