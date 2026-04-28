declare module "@modelcontextprotocol/sdk/server/streamableHttp.js" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export type StreamableHTTPServerTransportOptions = {
    sessionIdGenerator?: (() => string) | undefined;
  };

  export class StreamableHTTPServerTransport {
    constructor(options?: StreamableHTTPServerTransportOptions);
    get sessionId(): string | undefined;
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: unknown, options?: { relatedRequestId?: string | number }): Promise<void>;
    handleRequest(
      req: IncomingMessage & { auth?: unknown },
      res: ServerResponse,
      parsedBody?: unknown,
    ): Promise<void>;
  }
}
