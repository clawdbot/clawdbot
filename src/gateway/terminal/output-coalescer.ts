import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";

const TERMINAL_OUTPUT_COALESCE_WINDOW_MS = 4;
const TERMINAL_OUTPUT_FRAME_BYTES = 64 * 1024;

/** Batches adjacent PTY chunks while keeping each emitted frame UTF-8 bounded. */
export class TerminalOutputCoalescer {
  private readonly emit: (data: string) => void;
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (data: string) => void) {
    this.emit = emit;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  push(data: string, opts?: { flushNow?: boolean }): void {
    let remaining = data;
    while (remaining) {
      const available = TERMINAL_OUTPUT_FRAME_BYTES - this.bufferedBytes;
      const part = truncateUtf8Prefix(remaining, available);
      if (!part) {
        this.flush();
        continue;
      }
      this.chunks.push(part);
      this.bufferedBytes += Buffer.byteLength(part, "utf8");
      remaining = remaining.slice(part.length);
      if (this.bufferedBytes >= TERMINAL_OUTPUT_FRAME_BYTES) {
        this.flush();
      }
    }
    if (opts?.flushNow) {
      this.flush();
    } else {
      this.schedule();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.chunks.length === 0) {
      return;
    }
    const data = this.chunks.join("");
    this.chunks = [];
    this.bufferedBytes = 0;
    this.emit(data);
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chunks = [];
    this.bufferedBytes = 0;
  }

  dispose(opts?: { flush?: boolean }): void {
    if (opts?.flush) {
      this.flush();
    } else {
      this.clear();
    }
  }

  private schedule(): void {
    if (this.timer || this.chunks.length === 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, TERMINAL_OUTPUT_COALESCE_WINDOW_MS);
    this.timer.unref?.();
  }
}
