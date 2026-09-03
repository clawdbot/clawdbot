import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSignalSseLoop, type SignalStatusSink } from "./sse-reconnect.js";

const servers: Server[] = [];

async function startRejectingSignalServer(
  status: number,
  statusMessage: string,
  onRequest?: (requestCount: number) => void,
) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    onRequest?.(requests);
    response.statusMessage = statusMessage;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("rejected\n");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("runSignalSseLoop native HTTP boundary", () => {
  it("publishes one terminal status and stops after a permanent rejection", async () => {
    const abort = new AbortController();
    const endpoint = await startRejectingSignalServer(
      400,
      "Account Selection Required",
      (requestCount) => {
        if (requestCount === 2) {
          abort.abort();
        }
      },
    );
    const statusSink = vi.fn<SignalStatusSink>();

    await runSignalSseLoop({
      baseUrl: endpoint.baseUrl,
      account: "+15555550100",
      abortSignal: abort.signal,
      runtime: createRuntime(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(endpoint.requestCount()).toBe(1);
    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledWith({
      lifecycle: "blocked",
      terminalDisconnect: true,
      connected: false,
      lastError:
        "Signal daemon rejected the event stream: Signal SSE failed (400 Account Selection Required). Check the configured account and daemon URL, fix the daemon or proxy response, then restart the channel.",
    });
  });

  it("keeps reconnecting after a transient HTTP rejection", async () => {
    const endpoint = await startRejectingSignalServer(503, "Try Again Later");
    const abort = new AbortController();
    const patches: Array<Omit<ChannelAccountSnapshot, "accountId">> = [];

    await runSignalSseLoop({
      baseUrl: endpoint.baseUrl,
      account: "+15555550100",
      abortSignal: abort.signal,
      runtime: createRuntime(),
      onEvent: vi.fn(),
      policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      statusSink: (patch) => {
        patches.push(patch);
        if (endpoint.requestCount() === 2) {
          abort.abort();
        }
      },
    });

    expect(endpoint.requestCount()).toBe(2);
    expect(patches).toHaveLength(2);
    expect(patches).toEqual([
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    ]);
    expect(patches).not.toContainEqual(expect.objectContaining({ terminalDisconnect: true }));
  });
});
