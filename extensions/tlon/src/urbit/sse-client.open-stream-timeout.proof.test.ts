import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const CONNECT_TIMEOUT_MS = 60_000;
const STORM_ATTEMPTS = 5;

const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

const runningServers: Server[] = [];

async function startStreamServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

function connectTimeoutHandles(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
): ReturnType<typeof setTimeout>[] {
  return setTimeoutSpy.mock.results
    .filter((_result: { value: unknown }, index: number) => {
      return setTimeoutSpy.mock.calls[index]?.[1] === CONNECT_TIMEOUT_MS;
    })
    .map((result: { value: unknown }) => result.value as ReturnType<typeof setTimeout>);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("UrbitSSEClient openStream connect-timeout proof", () => {
  it("clears connect timers after a real non-OK stream response storm", async () => {
    const { baseUrl, requests } = await startStreamServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("unavailable");
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const client = new UrbitSSEClient(baseUrl, "urbauth-~zod=proof", {
      autoReconnect: false,
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
    });

    for (let attempt = 0; attempt < STORM_ATTEMPTS; attempt += 1) {
      await expect(client.openStream()).rejects.toThrow("Stream connection failed: 503");
    }

    const armed = connectTimeoutHandles(setTimeoutSpy);
    expect(armed).toHaveLength(STORM_ATTEMPTS);
    for (const handle of armed) {
      expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
    }
    expect(requests.filter((entry) => entry.startsWith("GET /~/channel/"))).toHaveLength(
      STORM_ATTEMPTS,
    );
  });

  it("clears the connect timer when production urbitFetch rejects", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    // Controlled failure: accept then immediately destroy the socket so the
    // production urbitFetch / SSRF path rejects without depending on a free port.
    const server = createServer();
    server.on("connection", (socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    runningServers.push(server);
    const address = server.address() as AddressInfo;

    const client = new UrbitSSEClient(`http://127.0.0.1:${address.port}`, "urbauth-~zod=proof", {
      autoReconnect: false,
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
    });

    await expect(client.openStream()).rejects.toThrow();

    const armed = connectTimeoutHandles(setTimeoutSpy);
    expect(armed).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]);
  });
});
