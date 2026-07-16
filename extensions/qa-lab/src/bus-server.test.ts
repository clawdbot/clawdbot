import { Agent, createServer, request } from "node:http";
import { describe, expect, it } from "vitest";
import { closeQaHttpServer } from "./bus-server.js";

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server to bind a TCP port");
  }
  return address.port;
}

async function requestOnce(params: { port: number; agent: Agent }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: "/",
        agent: params.agent,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("closeQaHttpServer", () => {
  it("closes idle keep-alive sockets so suite processes can exit", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "keep-alive",
      });
      res.end("ok");
    });
    const agent = new Agent({ keepAlive: true });
    const port = await listenOnLoopback(server);

    try {
      await requestOnce({ port, agent });
      const startedAt = Date.now();
      await closeQaHttpServer(server);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      agent.destroy();
      server.closeAllConnections?.();
    }
  });
});
