import { StringDecoder } from "node:string_decoder";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";

export const DEFAULT_MAX_PENDING_UTF8_LINE_BYTES = 8 * 1024;

export type Utf8LineAccumulator = {
  decoder: StringDecoder;
  pendingLine: string;
  pendingLineTruncated: boolean;
  skipLeadingLf: boolean;
};

type AccumulatedUtf8Line = {
  line: string;
  truncated: boolean;
};

export function createUtf8LineAccumulator(): Utf8LineAccumulator {
  return {
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
    pendingLineTruncated: false,
    skipLeadingLf: false,
  };
}

function boundLine(value: string, maxBytes: number | undefined): AccumulatedUtf8Line {
  if (maxBytes === undefined) {
    return { line: value, truncated: false };
  }
  const line = truncateUtf8Suffix(value, maxBytes);
  return { line, truncated: line !== value };
}

export function appendUtf8Lines(params: {
  accumulator: Utf8LineAccumulator;
  chunk: Buffer | string;
  maxPendingLineBytes: number;
  maxLineBytes?: number;
  splitOnCarriageReturn?: boolean;
}): AccumulatedUtf8Line[] {
  let text = params.accumulator.decoder.write(
    Buffer.isBuffer(params.chunk) ? params.chunk : Buffer.from(params.chunk, "utf8"),
  );
  if (!text) {
    return [];
  }
  if (params.accumulator.skipLeadingLf && text.startsWith("\n")) {
    text = text.slice(1);
  }
  params.accumulator.skipLeadingLf = false;
  if (!text) {
    return [];
  }

  const hadTruncatedCarry = params.accumulator.pendingLineTruncated;
  const combined = params.accumulator.pendingLine + text;
  params.accumulator.skipLeadingLf =
    params.splitOnCarriageReturn === true && combined.endsWith("\r");
  const lines = params.splitOnCarriageReturn
    ? combined.split(/\r\n|[\r\n]/u)
    : combined.split(/\r?\n/u);
  params.accumulator.pendingLine = lines.pop() ?? "";
  params.accumulator.pendingLineTruncated = lines.length === 0 && hadTruncatedCarry;

  const completed = lines.map((line, index) => {
    const bounded = boundLine(line, params.maxLineBytes);
    return {
      line: bounded.line,
      truncated: bounded.truncated || (index === 0 && hadTruncatedCarry),
    };
  });
  const pending = boundLine(params.accumulator.pendingLine, params.maxPendingLineBytes);
  params.accumulator.pendingLine = pending.line;
  params.accumulator.pendingLineTruncated ||= pending.truncated;
  return completed;
}

export function flushUtf8Line(
  accumulator: Utf8LineAccumulator,
  maxLineBytes: number,
): AccumulatedUtf8Line | undefined {
  const value = accumulator.pendingLine + accumulator.decoder.end();
  const bounded = boundLine(value, maxLineBytes);
  const truncated = accumulator.pendingLineTruncated || bounded.truncated;
  accumulator.pendingLine = "";
  accumulator.pendingLineTruncated = false;
  accumulator.skipLeadingLf = false;
  return bounded.line ? { line: bounded.line, truncated } : undefined;
}
