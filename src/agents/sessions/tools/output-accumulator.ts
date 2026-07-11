/**
 * Streaming output accumulator for tool execution.
 *
 * Keeps bounded display tails in memory while spilling full output to private temp files when needed.
 */
import type { WriteStream } from "node:fs";
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
  transformDecodedText?: (text: string) => string;
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
  private readonly transformDecodedText?: (text: string) => string;
  private readonly decoder = new TextDecoder();

  private spillChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "openclaw-output";
    this.transformDecodedText = options.transformDecodedText;
  }

  append(data: Buffer): string {
    if (this.finished) {
      throw new Error("Cannot append to a finished output accumulator");
    }

    this.totalRawBytes += data.length;
    const decodedText = this.decoder.decode(data, { stream: true });
    const text = this.transformDecodedText?.(decodedText) ?? decodedText;
    this.appendDecodedText(text);

    // Transformed output must spill exactly what callers see so sanitization
    // cannot be bypassed by reading the full-output file.
    const spillChunk = this.transformDecodedText ? Buffer.from(text, "utf-8") : data;
    if (this.tempFileStream || this.shouldUseTempFile()) {
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
    const decodedText = this.decoder.decode();
    const text = this.transformDecodedText?.(decodedText) ?? decodedText;
    this.appendDecodedText(text);
    if (this.transformDecodedText && text.length > 0) {
      this.appendSpillChunk(Buffer.from(text, "utf-8"));
    }
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
    return text;
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
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
      fullOutputPath: this.tempFilePath,
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) {
      return;
    }

    const stream = this.tempFileStream;
    this.tempFileStream = undefined;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
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
      this.trimTail();
    }

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length) {
      const byte = buffer.at(start);
      if (byte === undefined || (byte & 0xc0) !== 0x80) {
        break;
      }
      start++;
    }

    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer.at(start - 1) === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) {
      return this.tailText;
    }

    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
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
    if (this.tempFileStream) {
      this.tempFileStream.write(chunk);
    } else {
      this.spillChunks.push(chunk);
    }
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) {
      return;
    }
    const tempFile = createPrivateTempWriteStream(this.tempFilePrefix);
    this.tempFilePath = tempFile.path;
    this.tempFileStream = tempFile.stream;
    for (const chunk of this.spillChunks) {
      this.tempFileStream.write(chunk);
    }
    this.spillChunks = [];
  }
}
