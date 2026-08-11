import type { Server as HttpServer, ServerResponse } from "node:http";
// Gateway HTTP upgrade-claim tests use a real TCP client so Node's request vs.
// upgrade dispatch stays part of the regression coverage.
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

async function listen(server: HttpServer): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function sendRawHttpRequest(port: number, rawRequest: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        new Error(`timed out waiting for gateway response; received ${response.length} bytes`),
      );
    }, 1_000);

    function finish(result: string | Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(rawRequest);
    });
    socket.on("data", (chunk) => {
      response += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        finish(response);
      }
    });
    socket.once("error", finish);
    socket.once("end", () => {
      if (response) {
        finish(response);
        return;
      }
      finish(new Error("gateway closed the socket without a response"));
    });
  });
}

function createServerWithHook(handler: (res: ServerResponse) => void): HttpServer {
  return createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async (_req, res) => {
      handler(res);
      return true;
    },
    resolvedAuth,
    getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }) as OpenClawConfig,
  });
}

describe("gateway HTTP upgrade claims", () => {
  it("rejects websocket upgrade headers that Node routes as ordinary HTTP", async () => {
    const handleHooksRequest = vi.fn((res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
    });
    const server = createServerWithHook(handleHooksRequest);
    const port = await listen(server);

    try {
      const response = await sendRawHttpRequest(
        port,
        [
          "GET /hooks/wake HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );

      expect(response).toContain("HTTP/1.1 400 Bad Request");
      expect(response).toContain("Connection: close");
      expect(handleHooksRequest).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("keeps ordinary HTTP requests on the normal request path", async () => {
    const handleHooksRequest = vi.fn((res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
    });
    const server = createServerWithHook(handleHooksRequest);
    const port = await listen(server);

    try {
      const response = await sendRawHttpRequest(
        port,
        [
          "GET /hooks/wake HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );

      expect(response).toContain("HTTP/1.1 204 No Content");
      expect(handleHooksRequest).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it("leaves real websocket upgrades on Node's upgrade event", async () => {
    const handleHooksRequest = vi.fn((res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
    });
    const server = createServerWithHook(handleHooksRequest);
    const upgradeSeen = new Promise<void>((resolve) => {
      server.once("upgrade", (_req, socket) => {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        resolve();
      });
    });
    const port = await listen(server);

    try {
      const response = await sendRawHttpRequest(
        port,
        [
          "GET /hooks/wake HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: keep-alive, Upgrade",
          "Sec-WebSocket-Key: dGVzdC1rZXktMDEyMzQ1Ng==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );

      await upgradeSeen;
      expect(response).toContain("HTTP/1.1 400 Bad Request");
      expect(handleHooksRequest).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
