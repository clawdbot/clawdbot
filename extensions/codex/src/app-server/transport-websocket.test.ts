// Codex tests cover transport websocket plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerUnixSocketPath } from "./transport-websocket.js";

describe("Codex app-server websocket transport", () => {
  const clients: CodexAppServerClient[] = [];
  const servers: WebSocketServer[] = [];
  const httpServers: http.Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await Promise.all(
      httpServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("can speak JSON-RPC over websocket transport", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.143.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const client = CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
      authToken: "secret",
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("model/list", {})).resolves.toEqual({ data: [] });
    expect(authHeaders).toEqual(["Bearer secret"]);
  });

  it("can speak JSON-RPC over the canonical unix control socket", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-unix-"));
    tempDirs.push(tempDir);
    const socketPath = path.join(tempDir, "app-server.sock");
    const httpServer = http.createServer();
    httpServers.push(httpServer);
    const server = new WebSocketServer({ server: httpServer });
    servers.push(server);
    const upgradeExtensions: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      upgradeExtensions.push(request.headers["sec-websocket-extensions"]);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.144.1" } }),
          );
          return;
        }
        if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const client = CodexAppServerClient.start({
      transport: "unix",
      homeScope: "user",
      url: `unix://${socketPath}`,
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(upgradeExtensions).toEqual([undefined]);
  });

  it("resolves the default control socket under CODEX_HOME", () => {
    expect(
      resolveCodexAppServerUnixSocketPath({
        transport: "unix",
        url: "unix://",
        env: { CODEX_HOME: "/tmp/custom-codex-home" },
      }),
    ).toBe("/tmp/custom-codex-home/app-server-control/app-server-control.sock");
  });

  it("rejects unix URLs unless the unix transport is explicit", () => {
    expect(() =>
      resolveCodexAppServerUnixSocketPath({
        transport: "websocket",
        url: "unix://",
      }),
    ).toThrow("codex app-server unix URL requires unix transport");
  });
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
