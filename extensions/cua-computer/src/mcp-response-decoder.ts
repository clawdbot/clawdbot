import type { mcpStdioRuntime } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";

type McpStdioRuntime = Awaited<ReturnType<typeof mcpStdioRuntime.load>>;
type McpStdioDecoder = NonNullable<
  ConstructorParameters<McpStdioRuntime["OpenClawStdioClientTransport"]>[0]["decoder"]
>;
type McpMessage = NonNullable<ReturnType<McpStdioDecoder["readMessage"]>>;

const MAX_MCP_LINE_BYTES = 256 * 1024 * 1024;

export class CuaMcpResponseDecoder implements McpStdioDecoder {
  private pending = Buffer.alloc(0);
  private pendingBytes = 0;
  private chunk: Buffer = Buffer.alloc(0);
  private cursor = 0;

  constructor(private readonly protocolError: (message: string, cause?: unknown) => Error) {}

  append(chunk: Buffer): void {
    if (this.pendingBytes + chunk.length > MAX_MCP_LINE_BYTES) {
      throw this.protocolError("CUA MCP response exceeded the line-size limit");
    }
    this.chunk = chunk;
    this.cursor = 0;
  }

  readMessage(): McpMessage | null {
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
      let response: Record<string, unknown> | undefined;
      try {
        response = record(JSON.parse(line.toString("utf8")));
      } catch (error) {
        throw this.protocolError("CUA MCP proxy returned invalid JSON", error);
      }
      if (response?.jsonrpc !== "2.0") {
        throw this.protocolError("CUA MCP proxy returned an invalid JSON-RPC version");
      }
      if (typeof response.id !== "number" || !Number.isSafeInteger(response.id)) {
        throw this.protocolError("CUA MCP proxy returned an invalid response id");
      }
      // Preserve CUA's response/error policy; SDK correlation sees a standard result envelope.
      return {
        jsonrpc: "2.0",
        id: response.id - 1,
        result: { value: response.result, error: response.error },
      };
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
      const capacity = Math.min(MAX_MCP_LINE_BYTES, Math.max(required, this.pending.length * 2));
      const pending = Buffer.allocUnsafe(capacity);
      this.pending.copy(pending, 0, 0, this.pendingBytes);
      this.pending = pending;
    }
    chunk.copy(this.pending, this.pendingBytes);
    this.pendingBytes = required;
  }
}
