/**
 * Streaming output accumulator for tool execution.
 *
 * Keeps bounded display tails in memory while spilling full output to private temp files when needed.
 */
import { finished } from "node:stream/promises";
import { truncateUtf8Suffix } from "../../../utils/utf8-truncate.js";
import { createPrivateTempWriteStream } from "./private-temp-file.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type TruncationResult,
  truncateTail,
} from "./truncate.js";

interface OutputAccumulatorOptions {
  maxLines?: number;
  maxBytes?: number;
  tempFilePrefix?: string;
  createTextDecoder?: () => OutputTextDecoder;
  /**
   * Builds the decoded-text transform. Called once per stream lane so stateful
   * transforms (ANSI parsers) cannot consume another stream's pending sequence.
   */
  createTextTransform?: () => (text: string) => string;
}

type OutputStream = "stdout" | "stderr";

export interface OutputTextDecoder {
  decode(chunk: Buffer | string): string;
  flush(): string;
}

function createUtf8TextDecoder(): OutputTextDecoder {
  const decoder = new TextDecoder();
  return {
    decode: (chunk) =>
      typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
    flush: () => decoder.decode(),
  };
}

/** Per-stream decode state. Streams are independent pipes and must not share it. */
interface DecodeLane {
  decoder: OutputTextDecoder;
  transform?: (text: string) => string;
  spillDecoded: boolean;
}

interface OutputSnapshot {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private readonly createTextDecoder: () => OutputTextDecoder;
  private readonly spillDecodedByDefault: boolean;
  private readonly createTextTransform?: () => (text: string) => string;
  private readonly lanes = new Map<OutputStream | undefined, DecodeLane>();

  private spillChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private lastLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFile:
    | (ReturnType<typeof createPrivateTempWriteStream> & { completion: Promise<void> })
    | undefined;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // UTF-8 trimming can drop three bytes; truncateTail also ignores a final newline.
    // Keep enough extra bytes that an incomplete leading line cannot fit the display.
    this.maxRollingBytes = Math.max(this.maxBytes * 2, this.maxBytes + 5);
    this.tempFilePrefix = options.tempFilePrefix ?? "openclaw-output";
    this.createTextDecoder = options.createTextDecoder ?? createUtf8TextDecoder;
    this.spillDecodedByDefault = options.createTextDecoder !== undefined;
    this.createTextTransform = options.createTextTransform;
  }

  private lane(stream?: OutputStream): DecodeLane {
    let lane = this.lanes.get(stream);
    if (!lane) {
      lane = {
        decoder: this.createTextDecoder(),
        transform: this.createTextTransform?.(),
        // Tagged streams and custom decoders must spill decoded text so the
        // full-output artifact matches the text shown to callers.
        spillDecoded:
          stream !== undefined ||
          this.createTextTransform !== undefined ||
          this.spillDecodedByDefault,
      };
      this.lanes.set(stream, lane);
    }
    return lane;
  }

  append(data: Buffer, stream?: OutputStream): string {
    if (this.finished) {
      throw new Error("Cannot append to a finished output accumulator");
    }

    this.totalRawBytes += data.length;
    const lane = this.lane(stream);
    const decodedText = lane.decoder.decode(data);
    const text = lane.transform?.(decodedText) ?? decodedText;
    this.appendDecodedText(text);

    // Decoded/transformed output must spill exactly what callers see.
    const spillChunk = lane.spillDecoded ? Buffer.from(text, "utf-8") : data;
    if (this.tempFile || this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
    this.appendSpillChunk(spillChunk);
    return text;
  }

  finish(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    // Every lane holds its own pending bytes, so all of them must be flushed.
    let flushed = "";
    for (const lane of this.lanes.values()) {
      const decodedText = lane.decoder.flush();
      const text = lane.transform?.(decodedText) ?? decodedText;
      if (text.length === 0) {
        continue;
      }
      this.appendDecodedText(text);
      if (lane.spillDecoded) {
        this.appendSpillChunk(Buffer.from(text, "utf-8"));
      }
      flushed += text;
    }
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
    return flushed;
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.tailText, {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };

    if (options.persistIfTruncated && truncation.truncated) {
      this.ensureTempFile();
    }

    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFile?.path,
    };
  }

  async closeTempFile(): Promise<void> {
    const tempFile = this.tempFile;
    if (!tempFile) {
      return;
    }

    tempFile.stream.end();
    await tempFile.completion;
  }

  getLastLineBytes(): number {
    return this.lastLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) {
      return;
    }

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.tailText = truncateUtf8Suffix(this.tailText, this.maxRollingBytes);
      this.tailBytes = byteLength(this.tailText);
    }

    // A terminator closes the last real line; its size still belongs in the footer.
    for (let start = 0; start < text.length;) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      this.lastLineBytes =
        (this.hasOpenLine ? this.lastLineBytes : 0) + byteLength(text.slice(start, end));
      this.hasOpenLine = newline === -1;
      if (!this.hasOpenLine) {
        this.completedLines++;
      }
      start = end + 1;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    );
  }

  private appendSpillChunk(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    if (this.tempFile) {
      this.tempFile.stream.write(chunk);
    } else {
      this.spillChunks.push(chunk);
    }
  }

  private ensureTempFile(): void {
    if (this.tempFile) {
      return;
    }
    const tempFile = createPrivateTempWriteStream(this.tempFilePrefix);
    // Own stream errors before the first write, retaining finished()'s listeners.
    // Handle early rejection now; closeTempFile still awaits the original promise.
    const completion = finished(tempFile.stream);
    void completion.catch(() => undefined);
    this.tempFile = { ...tempFile, completion };
    for (const chunk of this.spillChunks) {
      tempFile.stream.write(chunk);
    }
    this.spillChunks = [];
  }
}
