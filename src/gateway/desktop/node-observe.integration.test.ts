import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_DESKTOP_STREAM_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  invokeNodeDesktopStream,
  invokeNodeWorkerDesktopStream,
} from "../../node-host/desktop-stream-command.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { NodeRegistry } from "../node-registry.js";
import { environmentsHandlers } from "../server-methods/environments.js";
import { createWorkerNodeDesktopCarrier } from "../worker-environments/node-desktop-carrier.js";
import * as workerSupport from "../worker-environments/service.test-support.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const cleanups: Array<() => Promise<void>> = [];

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class SocketReader {
  private buffered = Buffer.alloc(0);
  private readonly waiters = new Set<() => void>();

  constructor(socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buffered = Buffer.concat([
        this.buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      for (const waiter of this.waiters) {
        waiter();
      }
      this.waiters.clear();
    });
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }
}

class WebSocketReader {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(chunk: Buffer) => void> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(chunk);
      } else {
        this.chunks.push(chunk);
      }
    });
  }

  async next(): Promise<Buffer> {
    return (
      this.chunks.shift() ??
      (await new Promise<Buffer>((resolve) => {
        this.waiters.push(resolve);
      }))
    );
  }
}

type RfbHarness = {
  completion: Promise<void>;
  connectionCount: () => number;
  peers: Set<net.Socket>;
  port: number;
};

async function startRfbHarness(expectedStreams: number): Promise<RfbHarness> {
  const peers = new Set<net.Socket>();
  let connectionCount = 0;
  let completedStreams = 0;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    // Session teardown destroys client sockets; the synthetic server owns the matching resets.
    socket.on("error", handleExpectedPeerTeardownError);
    connectionCount += 1;
    const connectionIndex = connectionCount;
    const reader = new SocketReader(socket);
    void (async () => {
      try {
        socket.write(VERSION);
        expect(await reader.readExactly(VERSION.length)).toEqual(VERSION);
        socket.write(Buffer.from([1, 2]));
        // Every observer first probes RFB security, then opens the streaming connection.
        if (connectionIndex % 2 === 1) {
          return;
        }
        expect(await reader.readExactly(1)).toEqual(Buffer.from([2]));
        socket.write(Buffer.alloc(16, 7));
        expect(await reader.readExactly(16)).toHaveLength(16);
        socket.write(Buffer.alloc(4));

        expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
        socket.write(Buffer.from("pixel-update", "ascii"));
        const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
        expect(await reader.readExactly(framebufferRequest.length)).toEqual(framebufferRequest);
        completedStreams += 1;
        if (completedStreams === expectedStreams) {
          resolveCompletion();
        }
      } catch (error) {
        rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const peer of peers) {
          peer.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return {
    completion,
    connectionCount: () => connectionCount,
    peers,
    port: address.port,
  };
}

async function startDesktopGateway(params: {
  desktopRegistry: ReturnType<typeof createDesktopSessionRegistry>;
  nodeRegistry: NodeRegistry;
  streamBroker: ReturnType<typeof createNodeDesktopStreamBroker>;
}): Promise<string> {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      if (await params.streamBroker.handleUpgrade(req, socket, head, params.nodeRegistry)) {
        return;
      }
      handleDesktopObserveUpgrade(req, socket, head, { registry: params.desktopRegistry });
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected Gateway address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${address.port}`;
}

async function openViewOnlyObserver(gatewayUrl: string, wsPath: string): Promise<WebSocket> {
  const ws = new WebSocket(`${gatewayUrl}${wsPath}`);
  const browser = new WebSocketReader(ws);
  cleanups.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  expect(await browser.next()).toEqual(VERSION);
  ws.send(Buffer.concat([VERSION, Buffer.from([1, 0])]));
  expect(await browser.next()).toEqual(Buffer.from([1, 1]));
  expect(await browser.next()).toEqual(Buffer.alloc(4));
  expect(await browser.next()).toEqual(Buffer.from("pixel-update", "ascii"));

  const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
  const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
  ws.send(Buffer.concat([keyEvent, framebufferRequest]));
  return ws;
}

async function expectObserversClosed(params: {
  observers: readonly WebSocket[];
  peers: Set<net.Socket>;
  stop: () => Promise<unknown>;
}): Promise<void> {
  const closed = params.observers.map(
    (observer) =>
      new Promise<void>((resolve) => {
        observer.once("close", () => resolve());
      }),
  );
  await params.stop();
  await Promise.all(closed);
  await vi.waitFor(() => expect(params.peers.size).toBe(0));
}

describe("paired node desktop observe integration", () => {
  it("relays pixels through the node attach socket and drops view-only input", async () => {
    const rfb = await startRfbHarness(2);

    const desktopRegistry = createDesktopSessionRegistry({ lingerMs: 10 });
    const streamBroker = createNodeDesktopStreamBroker();
    cleanups.push(async () => desktopRegistry.stopAll());
    let gatewayUrl = "";
    const nodeSession = {
      nodeId: "node-1",
      connId: "conn-1",
      pairingGeneration: "generation-1",
      platform: "linux",
      deviceFamily: "Linux",
      commands: [NODE_DESKTOP_STREAM_COMMAND],
    };
    const nodeRegistry = {
      get: () => nodeSession,
      getForPairingGeneration: (_nodeId: string, generation: string) =>
        generation === nodeSession.pairingGeneration ? nodeSession : undefined,
      isConnectionCurrentPairingState: async (connId: string) => connId === nodeSession.connId,
      invoke: async (request: {
        params?: unknown;
        signal?: AbortSignal;
        onProgress?: (chunk: string) => void;
      }) => {
        try {
          await invokeNodeDesktopStream({
            paramsJSON: JSON.stringify({
              ...(request.params as { ticket: string; attachPath: string }),
            }),
            gatewayUrl,
            config: { enabled: true, port: rfb.port },
            signal: request.signal ?? new AbortController().signal,
            emitStatus: async (status) => request.onProgress?.(status),
          });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          };
        }
      },
    } as unknown as NodeRegistry;
    gatewayUrl = await startDesktopGateway({ desktopRegistry, nodeRegistry, streamBroker });

    const service = createNodeDesktopService({
      getConfig: () => ({
        gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
      }),
      nodeRegistry,
      desktopRegistry,
      streamBroker,
    });
    const observed = await service.observe({
      nodeId: nodeSession.nodeId,
      control: false,
      credentials: { password: "memory-only-password" },
    });
    expect(observed.auth).toBe("vnc-password");

    const ws = await openViewOnlyObserver(gatewayUrl, observed.wsPath);

    const secondObserved = await service.observe({
      nodeId: nodeSession.nodeId,
      control: false,
      credentials: { password: "memory-only-password" },
    });
    const secondWs = await openViewOnlyObserver(gatewayUrl, secondObserved.wsPath);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    await expect(rfb.completion).resolves.toBeUndefined();
    await vi.waitFor(() => expect(rfb.connectionCount()).toBe(4));
    await expectObserversClosed({
      observers: [ws, secondWs],
      peers: rfb.peers,
      stop: async () => service.stopNode(nodeSession.nodeId),
    });
  });
});

function workerNodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "worker-conn-1",
    pairingIdentity: "worker-identity-1",
    pairingGeneration: "worker-generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
}

async function observeEnvironmentDesktop(
  workerEnvironmentService: ReturnType<typeof workerSupport.createService>,
  environmentId: string,
) {
  const respond = vi.fn();
  await environmentsHandlers["desktop.observe"]?.({
    params: { source: { kind: "environment", environmentId }, control: false },
    respond,
    context: { workerEnvironmentService },
  } as never);
  const [ok, result, error] = respond.mock.calls.at(0) ?? [];
  expect(error).toBeUndefined();
  expect(ok).toBe(true);
  return result as { transport: "rfb"; wsPath: string; control: boolean };
}

describe("worker environment node desktop observe integration", () => {
  workerSupport.setupWorkerEnvironmentServiceSuite();

  it("carries an environment observer over its durable node and closes it on teardown", async () => {
    const rfb = await startRfbHarness(1);
    const passwordFilePath = path.join(workerSupport.testState.root, "vnc.password");
    await fs.writeFile(passwordFilePath, "memory-only-password\n", { mode: 0o600 });
    const record = workerSupport.seedReadyNodeDesktop("worker-node-desktop-byte-flow", {
      ...workerSupport.DESKTOP,
      port: rfb.port,
      passwordFilePath,
    });
    if (!record.nodeDeviceId) {
      throw new Error("expected durable worker node id");
    }

    const desktopRegistry = createDesktopSessionRegistry({ lingerMs: 10 });
    const streamBroker = createNodeDesktopStreamBroker();
    cleanups.push(async () => desktopRegistry.stopAll());
    const proof = workerNodeProof(record.nodeDeviceId);
    const pairingRegistry = {
      getForPairingGeneration: (nodeId: string, generation: string) =>
        nodeId === proof.nodeId && generation === proof.pairingGeneration ? proof : undefined,
      isConnectionCurrentPairingState: async (connId: string) => connId === proof.connId,
    } as unknown as NodeRegistry;
    let gatewayUrl = "";
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (!request.isDispatchAuthorized()) {
        return { ok: false, error: { code: "STALE", message: "desktop owner is stale" } };
      }
      try {
        await invokeNodeWorkerDesktopStream({
          paramsJSON: JSON.stringify(request.params),
          gatewayUrl,
          signal: request.signal ?? new AbortController().signal,
        });
        return { ok: true, payload: null };
      } catch (error) {
        return {
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    });
    const transport: NodeWorkerSupervisorTransport = {
      listCurrentNodes: async () => [proof],
      isCurrent: (candidate) =>
        candidate.nodeId === proof.nodeId &&
        candidate.connId === proof.connId &&
        candidate.pairingGeneration === proof.pairingGeneration,
      invoke,
    };
    const carrier = createWorkerNodeDesktopCarrier({
      store: workerSupport.testState.store,
      desktopRegistry,
    });
    carrier.bindRuntime({ transport, streamBroker });
    const workerEnvironmentService = workerSupport.createService(workerSupport.createProvider(), {
      nodeDesktopCarrier: carrier,
      now: Date.now,
    });
    gatewayUrl = await startDesktopGateway({
      desktopRegistry,
      nodeRegistry: pairingRegistry,
      streamBroker,
    });

    const observed = await observeEnvironmentDesktop(
      workerEnvironmentService,
      record.environmentId,
    );
    expect(observed).toMatchObject({ transport: "rfb", control: false });
    const observer = await openViewOnlyObserver(gatewayUrl, observed.wsPath);

    await expect(rfb.completion).resolves.toBeUndefined();
    await vi.waitFor(() => expect(rfb.connectionCount()).toBe(2));
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: NODE_WORKER_DESKTOP_STREAM_COMMAND,
        params: {
          ticket: expect.stringMatching(/^[a-f0-9]{48}$/u),
          attachPath: expect.stringMatching(/^\/node-desktop\/attach\?ticket=[a-f0-9]{48}$/u),
          port: rfb.port,
          passwordFilePath,
        },
      }),
    );
    await expectObserversClosed({
      observers: [observer],
      peers: rfb.peers,
      stop: async () => workerEnvironmentService.destroy(record.environmentId),
    });
    expect(workerSupport.testState.store.get(record.environmentId)?.state).toBe("destroyed");
    expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
