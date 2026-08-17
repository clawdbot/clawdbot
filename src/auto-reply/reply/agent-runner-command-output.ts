import { asFiniteNumber as readFiniteNumberValue } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecordValue } from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedAgentEvent } from "../../agents/embedded-agent-subscribe.shared-types.js";
import { inferToolMetaFromArgsCore } from "../../agents/tool-display.js";
import type { GetReplyOptions } from "../types.js";

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

function readNullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return readFiniteNumberValue(value);
}

function isCommandToolName(name: string | undefined): boolean {
  const normalized = name?.trim().toLowerCase();
  return normalized === "exec" || normalized === "bash" || normalized === "shell";
}

/** Projects a completed command-tool event into the channel command-output contract. */
export function buildCommandOutputFromToolResultEvent(
  evt: EmbeddedAgentEvent,
): Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0] | undefined {
  if (evt.stream !== "tool" || evt.data.phase !== "result") {
    return undefined;
  }
  const name = evt.data.name;
  const commandBearing = evt.data.commandBearing === true;
  if (!name || (!commandBearing && !isCommandToolName(name))) {
    return undefined;
  }
  const result = readRecordValue(evt.data.result);
  const details = readRecordValue(result?.details);
  const output =
    evt.data.output ??
    readStringValue(result?.output) ??
    readStringValue(details?.output) ??
    readToolResultText(evt.data.result);
  const explicitStatus =
    evt.data.status ?? readStringValue(result?.status) ?? readStringValue(details?.status);
  const exitCode = readNullableNumberValue(
    result?.exitCode ?? details?.exitCode ?? evt.data.exitCode,
  );
  const durationMs = readFiniteNumberValue(
    result?.durationMs ?? details?.durationMs ?? evt.data.durationMs,
  );
  const cwd = evt.data.cwd;
  const errorStatus =
    evt.data.isError === true ? "failed" : evt.data.isError === false ? "completed" : undefined;
  // A bare result carries no outcome of its own: runners that report one send a
  // separate command_output event, and synthesizing here would duplicate it.
  // A CLI result is different because its content *is* the outcome, which
  // readToolResultText surfaces as output above.
  const hasConcreteCommandResult =
    output !== undefined ||
    explicitStatus !== undefined ||
    exitCode !== undefined ||
    durationMs !== undefined ||
    cwd !== undefined ||
    (commandBearing && typeof evt.data.isError === "boolean") ||
    (result !== undefined && Object.keys(result).length > 0);
  if (!hasConcreteCommandResult) {
    return undefined;
  }
  // Keep the line describing the command, not its output: without a title the
  // terminal line would replace the request with whatever the tool printed.
  const args = evt.data.args;
  const title =
    evt.data.title ??
    (args ? inferToolMetaFromArgsCore(name, args, { detailMode: "explain" }) : undefined);
  return {
    itemId: evt.data.itemId,
    phase: "end",
    title,
    toolCallId: evt.data.toolCallId,
    name,
    output,
    status: explicitStatus ?? errorStatus,
    exitCode,
    durationMs,
    cwd,
  };
}
