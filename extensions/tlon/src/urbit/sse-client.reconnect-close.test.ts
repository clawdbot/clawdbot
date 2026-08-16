import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const proofCookie = "urbauth-~zod=synthetic-reconnect-proof";
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
const runningServers: Server[] = [];

type UrbitChannelProof = {
  baseUrl: string;
  requests: string[];
  unauthorizedRequests: number;
};

async function startUrbitChannelServer(options: { holdStream?: boolean } = {}) {
  const proof: UrbitChannelProof = {
    baseUrl: "",
    requests: [],
    unauthorizedRequests: 0,
  };
  const heldStreams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (!(request.headers.cookie ?? "").includes(proofCookie)) {
      proof.unauthorizedRequests += 1;
      response.writeHead(401).end();
      return;
    }
    proof.requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.method === "GET") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      if (options.holdStream) {
        heldStreams.add(response);
        response.once("close", () => heldStreams.delete(response));
        response.write(": connected\n\n");
      } else {
        response.end();
      }
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  proof.baseUrl = `http://127.0.0.1:${address.port}`;
  return proof;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the real Tlon SSE reconnect lifecycle");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function expectPromptReconnectSettlement(reconnect: Promise<void>) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      reconnect.then(() => "settled" as const),
      new Promise<"timed out">((resolve) => {
        deadline = setTimeout(() => resolve("timed out"), 250);
      }),
    ]);
    expect(outcome).toBe("settled");
  } finally {
    if (deadline !== undefined) {
      clearTimeout(deadline);
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("UrbitSSEClient real reconnect shutdown lifecycle", () => {
  it("settles a real SSE reconnect when the monitor stops receiving", async () => {
    const proof = await startUrbitChannelServer();
    const logs: string[] = [];
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      reconnectDelay: 400,
      logger: { log: (message) => logs.push(message) },
      onReconnect,
    });
    const reconnectSpy = vi.spyOn(client, "attemptReconnect");

    try {
      await client.connect();
      await waitFor(() => logs.some((message) => message.includes("in 400ms")));
      const reconnect = reconnectSpy.mock.results[0]?.value as Promise<void> | undefined;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }

      const requestsBeforeStop = proof.requests.length;
      client.stopReceiving();
      await expectPromptReconnectSettlement(reconnect);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(proof.requests.some((request) => request.startsWith("GET /~/channel/"))).toBe(true);

      const unauthorizedResponse = await fetch(`${proof.baseUrl}/unauthorized-control`);
      expect(unauthorizedResponse.status).toBe(401);
      expect(proof.unauthorizedRequests).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("settles the real ten-second retry cooldown when the monitor stops receiving", async () => {
    const proof = await startUrbitChannelServer({ holdStream: true });
    const logs: string[] = [];
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      maxReconnectAttempts: 1,
      reconnectDelay: 20,
      logger: { log: (message) => logs.push(message) },
      onReconnect,
    });

    try {
      await client.connect();
      client.reconnectAttempts = client.maxReconnectAttempts;
      const reconnect = client.attemptReconnect();
      expect(logs.some((message) => message.includes("Waiting 10s"))).toBe(true);

      const requestsBeforeStop = proof.requests.length;
      client.stopReceiving();
      await expectPromptReconnectSettlement(reconnect);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(logs.some((message) => message.includes("reset, resuming"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("settles a real pending reconnect when the public client closes", async () => {
    const proof = await startUrbitChannelServer();
    const logs: string[] = [];
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      reconnectDelay: 400,
      logger: { log: (message) => logs.push(message) },
      onReconnect,
    });
    const reconnectSpy = vi.spyOn(client, "attemptReconnect");

    try {
      await client.connect();
      await waitFor(() => logs.some((message) => message.includes("in 400ms")));
      const reconnect = reconnectSpy.mock.results[0]?.value as Promise<void> | undefined;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }

      await client.close();
      const requestsAfterClose = proof.requests.length;
      await expectPromptReconnectSettlement(reconnect);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsAfterClose);
      expect(proof.requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("still reconnects an uninterrupted authenticated SSE stream", async () => {
    const proof = await startUrbitChannelServer();
    let reconnects = 0;
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      reconnectDelay: 25,
      onReconnect: (reconnectingClient) => {
        reconnects += 1;
        reconnectingClient.autoReconnect = false;
      },
    });

    try {
      await client.connect();
      await waitFor(() => reconnects === 1);
      await waitFor(
        () =>
          proof.requests.filter((request) => request.startsWith("GET /~/channel/")).length === 2,
      );
      expect(reconnects).toBe(1);
      expect(
        proof.requests.filter((request) => request.startsWith("GET /~/channel/")),
      ).toHaveLength(2);
      expect(proof.unauthorizedRequests).toBe(0);
    } finally {
      await client.close();
    }
  });
});
