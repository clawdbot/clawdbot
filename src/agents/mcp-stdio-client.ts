import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ResultSchema,
  type Notification,
  type Request,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import { isMcpRequestTimeoutError } from "./mcp-error.js";

type McpStdioClient = {
  connect: (transport: Transport) => Promise<void>;
  request: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  notification: (method: string, params: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
  isTimeout: (error: unknown) => boolean;
};

class StdioProtocol extends Protocol<Request, Notification, Result> {
  protected assertCapabilityForMethod(): void {
    // The caller owns initialization and remote capability negotiation.
  }
  protected assertNotificationCapability(): void {
    // This low-level client forwards the caller's protocol notifications.
  }
  protected assertRequestHandlerCapability(method: string): void {
    if (method !== "ping") {
      throw new Error(`MCP stdio request handler is not supported: ${method}`);
    }
  }
  protected assertTaskCapability(): never {
    throw new Error("MCP task helpers are not exposed by this client");
  }
  protected assertTaskHandlerCapability(): never {
    throw new Error("MCP task helpers are not exposed by this client");
  }
}

/** SDK-owned request correlation and deadlines, with caller-owned initialization policy. */
export function createMcpStdioClient(): McpStdioClient {
  const protocol = new StdioProtocol();
  return {
    connect: (transport) => protocol.connect(transport),
    request: (method, params, timeoutMs) =>
      protocol.request({ method, params }, ResultSchema, {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      }),
    notification: (method, params) => protocol.notification({ method, params }),
    close: () => protocol.close(),
    isTimeout: isMcpRequestTimeoutError,
  };
}
