// Tool Call Repair module parses XML-shaped plain-text tool payloads.
import {
  consumeLineBreak,
  consumeStructuralLineBreakAfterHorizontalWhitespace,
  scanXmlishToolCall,
  skipHorizontalWhitespace,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
} from "./grammar.js";
import type { PlainTextToolCallBlock } from "./payload.js";

type ParseXmlishToolCallOptions = {
  allowedToolNames?: ReadonlySet<string>;
  allowMissingFunctionClose?: boolean;
  maxPayloadBytes: number;
};

function extractXmlishParameterValue(
  text: string,
  start: number,
  end: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): string {
  let value = text.slice(start, end);
  if (consumeLineBreak(text, skipHorizontalWhitespace(text, start)) === null) {
    const boundary = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      start,
      structuralLineBreaks,
    );
    if (boundary !== null) {
      const offset = boundary - start;
      value = `${value.slice(0, offset)}\n${value.slice(offset)}`;
    }
  }
  const payloadStart = consumeLineBreak(value, 0);
  if (payloadStart === null) {
    return value;
  }
  return value.slice(payloadStart).replace(/(?:\r\n|[\r\n])$/u, "");
}

export function parseXmlishPlainTextToolCallBlockAt(
  text: string,
  start: number,
  options: ParseXmlishToolCallOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  const scan = scanXmlishToolCall(text, start, structuralLineBreaks);
  const completeScan =
    scan.kind === "complete"
      ? scan
      : options.allowMissingFunctionClose &&
          scan.kind === "prefix" &&
          scan.candidate?.syntax === "function" &&
          scan.candidate.nameComplete &&
          scan.candidate.parameters.length > 0 &&
          scan.candidate.activeParameterOpenEnd === undefined &&
          scan.candidate.payload?.end === text.length
        ? {
            ...scan.candidate,
            end: text.length,
            kind: "complete" as const,
            payload: scan.candidate.payload,
          }
        : undefined;
  if (!completeScan) {
    return null;
  }
  const name = text.slice(completeScan.name.start, completeScan.name.end);
  if (options.allowedToolNames && !options.allowedToolNames.has(name)) {
    return null;
  }
  if (
    utf8ByteLengthWithinLimit(
      text,
      completeScan.payload.start,
      completeScan.payload.end,
      options.maxPayloadBytes,
    ) === null
  ) {
    return null;
  }
  const args = Object.fromEntries(
    completeScan.parameters.map((parameter) => [
      text.slice(parameter.name.start, parameter.name.end),
      extractXmlishParameterValue(
        text,
        parameter.value.start,
        parameter.value.end,
        structuralLineBreaks,
      ),
    ]),
  );
  return {
    arguments: args,
    end: completeScan.end,
    name,
    raw: text.slice(start, completeScan.end),
    start,
  };
}
