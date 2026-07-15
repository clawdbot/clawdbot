// Tool Call Repair module implements standalone invoke-dialect strip helpers.
import { findCodeRegions, isInsideCode } from "@openclaw/normalization-core";
import {
  consumeLineBreak,
  consumeStructuralLineBreakAfterHorizontalWhitespace,
  DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES,
  scanXmlishToolCall,
  skipHorizontalWhitespace,
  skipLineIndentation,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
} from "./grammar.js";
import type { NormalizedPlainTextToolCallParseOptions, PlainTextToolCallBlock } from "./payload.js";

/** Advances the write cursor past a stripped block, consuming one trailing line break. */
export function advancePastStrippedBlock(text: string, blockEnd: number): number {
  const lineBreakStart = skipLineIndentation(text, blockEnd);
  return lineBreakStart === text.length
    ? lineBreakStart
    : (consumeLineBreak(text, lineBreakStart) ?? blockEnd);
}

/**
 * Builds the predicate that spares invoke-dialect examples sitting inside code.
 *
 * `isInsideCodeRegion` lets a caller supply its own code-region test computed
 * against the exact text handed in; when omitted a default Markdown code-region
 * scan is used so a bare package call still spares examples. Code regions are only
 * needed to spare invoke-dialect examples, and the scan is not free, so the default
 * is computed lazily on the first invoke candidate. Pass `() => false` to force a
 * strict scrub of every region.
 */
export function createPreservedInvokeExamplePredicate(
  text: string,
  isInsideCodeRegion?: (offset: number) => boolean,
): (offset: number) => boolean {
  let defaultCodeRegions: ReturnType<typeof findCodeRegions> | undefined;
  return (offset: number): boolean => {
    if (isInsideCodeRegion) {
      return isInsideCodeRegion(offset);
    }
    defaultCodeRegions ??= findCodeRegions(text);
    return isInsideCode(offset, defaultCodeRegions);
  };
}

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

/** Parses a standalone XML-ish `<invoke>`/`<tool_call>` block into a repair block. */
export function parseXmlishPlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: NormalizedPlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  const scan = scanXmlishToolCall(text, start, structuralLineBreaks);
  if (scan.kind !== "complete") {
    return null;
  }
  const name = text.slice(scan.name.start, scan.name.end);
  if (options?.allowedToolNames && !options.allowedToolNames.has(name)) {
    return null;
  }

  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  if (
    utf8ByteLengthWithinLimit(text, scan.payload.start, scan.payload.end, maxPayloadBytes) === null
  ) {
    return null;
  }
  const args = Object.fromEntries(
    scan.parameters.map((parameter) => [
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
    end: scan.end,
    name,
    raw: text.slice(start, scan.end),
    start,
  };
}
