// E2E coverage for OpenAI-compatible embedding proxy routing through the built CLI.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
const servers: Server[] = [];
const sockets = new Set<Duplex>();

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose a TCP address");
  }
  return address.port;
}

describe("OpenAI-compatible embedding proxy CLI", () => {
  it("uses the matching environment proxy during a deep memory status probe", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const endpoint = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
      })();
    });
    const endpointPort = await listen(endpoint);

    const authorities: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, clientSocket, head) => {
      authorities.push(request.url ?? "");
      const targetSocket = connect(endpointPort, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          targetSocket.write(head);
        }
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      for (const socket of [clientSocket, targetSocket]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      }
    });
    const proxyPort = await listen(proxy);

    const root = tempDirs.make("openclaw-memory-proxy-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        memory: {
          search: {
            provider: "openai-compatible",
            model: "proxy-proof-model",
            remote: {
              baseUrl: `http://embeddings.example.test:${endpointPort}/v1`,
              apiKey: "proof-key",
            },
          },
        },
        plugins: { slots: { memory: "memory-core" } },
      }),
    );

    const result = await execFileAsync(
      process.execPath,
      [path.resolve("openclaw.mjs"), "memory", "status", "--deep", "--agent", "main"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          http_proxy: `http://127.0.0.1:${proxyPort}`,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NO_COLOR: "1",
          NO_PROXY: "",
          no_proxy: "",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
          USERPROFILE: root,
          VITEST: undefined,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 90_000,
      },
    );

    expect(result.stdout).toContain("Embeddings: ready");
    expect(authorities).toEqual([`embeddings.example.test:${endpointPort}`]);
    expect(requests).toEqual([
      expect.objectContaining({ model: "proxy-proof-model", input: ["ping"] }),
    ]);
  }, 120_000);
});
