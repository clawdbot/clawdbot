import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export class McpStdioFrameError extends Error {}

export class McpStdioFrameDecoder {
  private pending = Buffer.alloc(0);
  private pendingBytes = 0;
  private chunk: Buffer = Buffer.alloc(0);
  private cursor = 0;

  constructor(private readonly maxFrameBytes: number) {}

  append(chunk: Buffer): void {
    if (this.pendingBytes + chunk.length > this.maxFrameBytes) {
      throw new McpStdioFrameError("response exceeded the line-size limit");
    }
    this.chunk = chunk;
    this.cursor = 0;
  }

  readMessage(): JSONRPCMessage | null {
    while (this.cursor < this.chunk.length) {
      const newline = this.chunk.indexOf(0x0a, this.cursor);
      if (newline < 0) {
        this.appendPending(this.chunk.subarray(this.cursor));
        this.chunk = Buffer.alloc(0);
        this.cursor = 0;
        return null;
      }
      let line = this.chunk.subarray(this.cursor, newline);
      this.cursor = newline + 1;
      if (this.pendingBytes > 0) {
        this.appendPending(line);
        line = this.pending.subarray(0, this.pendingBytes);
        this.pending = Buffer.alloc(0);
        this.pendingBytes = 0;
      }
      if (this.cursor === this.chunk.length) {
        this.chunk = Buffer.alloc(0);
        this.cursor = 0;
      }
      if (line.length === 0) {
        continue;
      }
      let response: unknown;
      try {
        response = JSON.parse(line.toString("utf8"));
      } catch (cause) {
        throw new McpStdioFrameError("proxy returned invalid JSON", { cause });
      }
      if (!isRecord(response) || response.jsonrpc !== "2.0") {
        throw new McpStdioFrameError("proxy returned an invalid JSON-RPC version");
      }
      if (("result" in response || "error" in response) && !Number.isSafeInteger(response.id)) {
        throw new McpStdioFrameError("proxy returned an invalid response id");
      }
      try {
        return JSONRPCMessageSchema.parse(response);
      } catch (cause) {
        throw new McpStdioFrameError("proxy returned an invalid JSON-RPC message", { cause });
      }
    }
    return null;
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
    this.pendingBytes = 0;
    this.chunk = Buffer.alloc(0);
    this.cursor = 0;
  }

  private appendPending(chunk: Buffer): void {
    const required = this.pendingBytes + chunk.length;
    if (required > this.pending.length) {
      const capacity = Math.min(this.maxFrameBytes, Math.max(required, this.pending.length * 2));
      const pending = Buffer.allocUnsafe(capacity);
      this.pending.copy(pending, 0, 0, this.pendingBytes);
      this.pending = pending;
    }
    chunk.copy(this.pending, this.pendingBytes);
    this.pendingBytes = required;
  }
}
