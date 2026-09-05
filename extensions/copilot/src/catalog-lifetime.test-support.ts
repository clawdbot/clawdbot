import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A loopback CLI protocol peer; the client, session, and tool dispatch are the real SDK. */
export async function createCopilotFaultPeer() {
  const sent = createDeferred<void>();
  const destroying = createDeferred<void>();
  const releaseDestroy = createDeferred<void>();
  const replies = new Map<string, ReturnType<typeof createDeferred<Record<string, unknown>>>>();
  const methods: string[] = [];
  const sockets = new Set<Socket>();
  let socket: Socket;
  let sessionId: string;
  let previousEventId: string | null = null;
  const send = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    socket.write(`Content-Length: ${bytes.length}\r\n\r\n`);
    socket.write(bytes);
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    const id = randomUUID();
    send({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        sessionId,
        event: {
          id,
          parentId: previousEventId,
          timestamp: new Date().toISOString(),
          type,
          data,
        },
      },
    });
    previousEventId = id;
  };
  const handle = async (request: Request) => {
    methods.push(request.method);
    switch (request.method) {
      case "connect":
        return { protocolVersion: 3 };
      case "session.create":
        sessionId = String(request.params.sessionId);
        return { sessionId };
      case "session.send":
        emit("user.message", { content: request.params.prompt });
        sent.resolve();
        return { messageId: "fixture-user" };
      case "session.tools.handlePendingToolCall":
        replies.get(String(request.params.requestId))?.resolve(request.params);
        return {};
      case "session.abort":
        return {};
      case "session.destroy":
        destroying.resolve();
        await releaseDestroy.promise;
        return {};
      default:
        throw new Error(`Unexpected Copilot fixture RPC: ${request.method}`);
    }
  };
  const server = createServer((connected) => {
    socket = connected;
    sockets.add(connected);
    connected.on("close", () => sockets.delete(connected));
    let buffer = Buffer.alloc(0);
    connected.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const separator = buffer.indexOf("\r\n\r\n");
        if (separator < 0) {
          return;
        }
        const length = Number(
          /Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1],
        );
        if (buffer.length < separator + 4 + length) {
          return;
        }
        const request = JSON.parse(
          buffer.subarray(separator + 4, separator + 4 + length).toString(),
        ) as Request;
        buffer = buffer.subarray(separator + 4 + length);
        void handle(request).then(
          (result) => send({ jsonrpc: "2.0", id: request.id, result }),
          (error: unknown) =>
            send({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP listener");
  }
  const client = new CopilotClient({
    connection: RuntimeConnection.forUri(`127.0.0.1:${address.port}`),
  });
  return {
    client,
    methods,
    sent: sent.promise,
    destroying: destroying.promise,
    releaseDestroy: () => releaseDestroy.resolve(),
    emit,
    requestTool(name: string, args: Record<string, unknown>) {
      const requestId = randomUUID();
      const reply = createDeferred<Record<string, unknown>>();
      replies.set(requestId, reply);
      emit("external_tool.requested", {
        requestId,
        toolCallId: requestId,
        toolName: name,
        arguments: args,
      });
      return reply.promise;
    },
    async close() {
      releaseDestroy.resolve();
      await client.stop();
      for (const connected of sockets) {
        connected.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
