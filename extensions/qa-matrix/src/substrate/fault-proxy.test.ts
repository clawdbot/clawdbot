import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startMatrixQaFaultProxy, type MatrixQaFaultProxy } from "./fault-proxy.js";

const servers: Array<{ close(): Promise<void> }> = [];

async function startTargetServer() {
  const requests: Array<{
    authorization?: string;
    body: string;
    method: string;
    url: string;
  }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    requests.push({
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      body: Buffer.concat(chunks).toString("utf8"),
      method: req.method ?? "GET",
      url: req.url ?? "/",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ forwarded: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("target server did not bind to a TCP port");
  }
  const handle = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    requests,
  };
  servers.push(handle);
  return handle;
}

describe("Matrix QA fault proxy", () => {
  let proxy: MatrixQaFaultProxy | undefined;

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("faults matching Matrix requests and forwards everything else", async () => {
    const target = await startTargetServer();
    proxy = await startMatrixQaFaultProxy({
      targetBaseUrl: target.baseUrl,
      rules: [
        {
          id: "room-key-backup-version-unavailable",
          match: (request) =>
            request.method === "GET" &&
            request.path === "/_matrix/client/v3/room_keys/version" &&
            request.bearerToken === "driver-token",
          response: () => ({
            body: {
              errcode: "M_NOT_FOUND",
              error: "No current key backup",
            },
            status: 404,
          }),
        },
      ],
    });

    const faulted = await fetch(`${proxy.baseUrl}/_matrix/client/v3/room_keys/version`, {
      headers: { authorization: "Bearer driver-token" },
    });
    expect(faulted.status).toBe(404);
    await expect(faulted.json()).resolves.toEqual({
      errcode: "M_NOT_FOUND",
      error: "No current key backup",
    });

    const forwarded = await fetch(`${proxy.baseUrl}/_matrix/client/v3/sync?timeout=0`, {
      body: JSON.stringify({ ok: true }),
      headers: {
        authorization: "Bearer driver-token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(forwarded.status).toBe(200);
    await expect(forwarded.json()).resolves.toEqual({ forwarded: true });

    expect(proxy.hits()).toEqual([
      {
        method: "GET",
        path: "/_matrix/client/v3/room_keys/version",
        ruleId: "room-key-backup-version-unavailable",
      },
    ]);
    expect(target.requests).toEqual([
      {
        authorization: "Bearer driver-token",
        body: '{"ok":true}',
        method: "POST",
        url: "/_matrix/client/v3/sync?timeout=0",
      },
    ]);
  });
});
