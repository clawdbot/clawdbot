import { createServer } from "node:http";
import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cleanupSessionResources } from "../session-resources.js";

export const responsesLoopbackModel = {
  id: "scripted-model",
  name: "Scripted Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
} satisfies Model<"openai-responses">;

export async function createResponsesLoopbackServer(events: (turn: number) => unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const authorization: Array<string | undefined> = [];
  let connections = 0;
  const eventsForRequest = (body: string) => {
    requests.push(JSON.parse(body) as Record<string, unknown>);
    return events(requests.length);
  };
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization);
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of eventsForRequest(body)) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    connections += 1;
    authorization.push(request.headers.authorization);
    socket.on("message", (body) => {
      if (!Buffer.isBuffer(body)) {
        throw new Error("Expected a Buffer from the WebSocket server");
      }
      for (const event of eventsForRequest(body.toString("utf8"))) {
        socket.send(JSON.stringify(event));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback TCP address");
  }
  // The replacement calls the original method with the active SDK client as this.
  // oxlint-disable-next-line typescript/unbound-method
  const buildURL = OpenAI.prototype.buildURL;
  // Route only the destination; native eligibility, the SDK, and request bytes stay real.
  const route = vi
    .spyOn(OpenAI.prototype, "buildURL")
    .mockImplementation(function (this: OpenAI, path, query, baseURL) {
      const url = new URL(buildURL.call(this, path, query, baseURL));
      expect(url.origin).toBe("https://api.openai.com");
      expect(url.pathname).toBe("/v1/responses");
      url.protocol = "http:";
      url.hostname = "127.0.0.1";
      url.port = String(address.port);
      return url.href;
    });
  return {
    requests,
    authorization,
    get connections() {
      return connections;
    },
    async close() {
      cleanupSessionResources();
      route.mockRestore();
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
