// Qa Lab Matrix tests cover fault proxy plugin behavior.
import { createServer, request } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { startMatrixQaFaultProxy } from "./fault-proxy.js";

type MatrixQaFaultProxy = Awaited<ReturnType<typeof startMatrixQaFaultProxy>>;

const servers: Array<{ close(): Promise<void> }> = [];

async function startTargetServer(params?: {
  responseBody?: Buffer | string;
  responseHeaders?: Record<string, string>;
}) {
  const requests: Array<{
    authorization?: string;
    body: string;
    method: string;
    url: string;
  }> = [];
  const server = createServer((req, res) => {
    void (async () => {
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
      res.writeHead(200, { "content-type": "application/json", ...params?.responseHeaders });
      res.end(params?.responseBody ?? JSON.stringify({ forwarded: true }));
    })();
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
          match: (proxyRequest) =>
            proxyRequest.method === "GET" &&
            proxyRequest.path === "/_matrix/client/v3/room_keys/version" &&
            proxyRequest.bearerToken === "driver-token",
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

  it("rejects request targets that resolve outside the configured origin", async () => {
    const target = await startTargetServer();
    proxy = await startMatrixQaFaultProxy({ targetBaseUrl: target.baseUrl, rules: [] });
    const proxyUrl = new URL(proxy.baseUrl);
    const requestTarget = async (path: string) =>
      await new Promise<{ body: string; status: number | undefined }>((resolve, reject) => {
        const req = request(
          {
            hostname: proxyUrl.hostname,
            path,
            port: proxyUrl.port,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ body: Buffer.concat(chunks).toString("utf8"), status: res.statusCode }),
            );
          },
        );
        req.once("error", reject);
        req.end();
      });

    for (const path of ["http://127.0.0.1:9/latest/meta-data", "/\\127.0.0.1:9/latest"]) {
      const response = await requestTarget(path);
      expect(response.status).toBe(400);
      expect(response.body).toContain("MATRIX_QA_FAULT_PROXY_INVALID_TARGET");
    }
    expect(target.requests).toEqual([]);
  });

  it("strips stale content-encoding after buffering decoded bodies", async () => {
    const body = Buffer.from(JSON.stringify({ forwarded: true }));
    const target = await startTargetServer({
      responseBody: gzipSync(body),
      responseHeaders: {
        "content-encoding": "gzip",
        "content-length": String(gzipSync(body).byteLength),
      },
    });
    proxy = await startMatrixQaFaultProxy({ targetBaseUrl: target.baseUrl, rules: [] });

    const response = await fetch(`${proxy.baseUrl}/encoded`);

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    await expect(response.json()).resolves.toEqual({ forwarded: true });
  });

  it("mutates matching forwarded Matrix responses", async () => {
    const target = await startTargetServer();
    proxy = await startMatrixQaFaultProxy({
      targetBaseUrl: target.baseUrl,
      rules: [
        {
          id: "sync-state-after",
          match: (proxyRequest) =>
            proxyRequest.method === "GET" &&
            proxyRequest.path === "/_matrix/client/v3/sync" &&
            proxyRequest.search.includes("org.matrix.msc4222.use_state_after=true"),
          mutateResponse: ({ response }) => ({
            ...response,
            body: Buffer.from(JSON.stringify({ forwarded: true, mutated: true })),
          }),
        },
      ],
    });

    const mutated = await fetch(
      `${proxy.baseUrl}/_matrix/client/v3/sync?timeout=0&org.matrix.msc4222.use_state_after=true`,
      {
        headers: { authorization: "Bearer driver-token" },
      },
    );

    expect(mutated.status).toBe(200);
    await expect(mutated.json()).resolves.toEqual({ forwarded: true, mutated: true });
    expect(proxy.hits()).toEqual([
      {
        method: "GET",
        path: "/_matrix/client/v3/sync",
        ruleId: "sync-state-after",
      },
    ]);
    expect(target.requests).toEqual([
      {
        authorization: "Bearer driver-token",
        body: "",
        method: "GET",
        url: "/_matrix/client/v3/sync?timeout=0&org.matrix.msc4222.use_state_after=true",
      },
    ]);
  });

  it("rejects oversized forwarded request bodies before contacting the target", async () => {
    const target = await startTargetServer();
    proxy = await startMatrixQaFaultProxy({
      maxRequestBytes: 4,
      targetBaseUrl: target.baseUrl,
      rules: [],
    });

    const rejected = await fetch(`${proxy.baseUrl}/_matrix/client/v3/send`, {
      body: "12345",
      method: "POST",
    });

    expect(rejected.status).toBe(413);
    expect(rejected.headers.get("connection")).toBe("close");
    await expect(rejected.json()).resolves.toMatchObject({
      errcode: "MATRIX_QA_FAULT_PROXY_REQUEST_TOO_LARGE",
    });
    expect(target.requests).toEqual([]);
  });

  it("rejects oversized forwarded Matrix responses without buffering the full body", async () => {
    const target = await startTargetServer({ responseBody: JSON.stringify({ payload: "large" }) });
    proxy = await startMatrixQaFaultProxy({
      maxResponseBytes: 8,
      targetBaseUrl: target.baseUrl,
      rules: [],
    });

    const rejected = await fetch(`${proxy.baseUrl}/_matrix/client/v3/sync`);

    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toMatchObject({
      errcode: "MATRIX_QA_FAULT_PROXY_RESPONSE_TOO_LARGE",
    });
    expect(target.requests).toEqual([
      {
        body: "",
        method: "GET",
        url: "/_matrix/client/v3/sync",
      },
    ]);
  });
});
