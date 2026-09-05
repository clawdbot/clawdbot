import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
} from "./minimal-gateway.test-helpers.js";

afterEach(() => {
  vi.doUnmock("ws");
  vi.doUnmock("./server.js");
  vi.doUnmock("../test-utils/ports.js");
  vi.doUnmock("../infra/device-pairing.js");
  vi.resetModules();
});

type PeerBehavior =
  | "hold upgrade"
  | "reject upgrade"
  | "no challenge"
  | "no response"
  | "reject auth"
  | "reject auth without close"
  | "transport error"
  | "upgrade then transport error"
  | "hello then transport error"
  | "reply";

type AcquisitionPeer = {
  port: number;
  clients: WebSocket[];
  closed: Set<WebSocket>;
  errors: Error[];
  unownedErrors: Error[];
  requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[];
  isListening: () => boolean;
  failTransport: () => Promise<Error>;
  close: () => Promise<void>;
};

async function withAcquisitionPeer(
  behavior: PeerBehavior,
  body: (peer: AcquisitionPeer) => Promise<void>,
) {
  const clients: WebSocket[] = [];
  const closed = new Set<WebSocket>();
  const errors: Error[] = [];
  const unownedErrors: Error[] = [];
  const transportFailure = createDeferred<Error>();
  const rejectAuth = behavior === "reject auth" || behavior === "reject auth without close";
  // Observe the real dependency; keep otherwise-unhandled errors local to this case.
  // Counting the remaining listeners makes a removed owner handler observable.
  vi.doMock("ws", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ws")>();
    class ObservedWebSocket extends actual.WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        clients.push(this);
        this.once("close", () => closed.add(this));
        this.on("error", (error) => {
          errors.push(error);
          transportFailure.resolve(error);
          if (this.listenerCount("error") === 1) {
            unownedErrors.push(error);
          }
        });
      }
    }
    return { ...actual, default: ObservedWebSocket, WebSocket: ObservedWebSocket };
  });
  const sockets = new Set<Socket>();
  const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (behavior === "hold upgrade") {
      return;
    }
    if (behavior === "reject upgrade") {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (behavior === "upgrade then transport error") {
      socket.cork();
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (behavior === "upgrade then transport error") {
        // Batch the native HTTP upgrade and invalid frame in one writev.
        socket.write(Buffer.from([0x83, 0x00]));
        socket.uncork();
        return;
      }
      if (behavior !== "no challenge") {
        sendMinimalGatewayConnectChallenge(ws);
      }
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        requests.push(frame);
        if (
          frame.method === "connect" &&
          (behavior === "transport error" || behavior === "hello then transport error")
        ) {
          socket.cork();
          if (behavior === "hello then transport error") {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: buildMinimalGatewayHelloOkPayload(),
              }),
            );
          }
          // A coalesced hello and invalid opcode must not become a successful acquisition.
          socket.write(Buffer.from([0x83, 0x00]));
          socket.uncork();
          return;
        }
        if (frame.method === "connect" && behavior !== "no response") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: !rejectAuth,
              ...(rejectAuth
                ? { error: { code: "UNAUTHORIZED", message: "synthetic auth rejection" } }
                : { payload: buildMinimalGatewayHelloOkPayload() }),
            }),
          );
          if (behavior === "reject auth without close") {
            ws.pause();
          }
        }
      });
    });
  });
  const close = async () => {
    // Release a withheld close handshake only after acquisition has entered server cleanup.
    for (const peer of wss.clients) {
      peer.resume();
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("acquisition peer did not bind");
    }
    await body({
      port: address.port,
      clients,
      closed,
      errors,
      unownedErrors,
      requests,
      isListening: () => server.listening,
      failTransport: () => {
        for (const socket of sockets) {
          socket.write(Buffer.from([0x83, 0x00]));
        }
        return transportFailure.promise;
      },
      close,
    });
  } finally {
    // Assertions run before this safety net: the broken helper must not leak into
    // another case, including when it rejects with a still-CONNECTING socket.
    const clientClosures = clients.map(async (client) => {
      if (client.readyState !== WebSocket.CLOSED) {
        const closure = new Promise<void>((resolve) => {
          client.once("close", () => resolve());
        });
        client.terminate();
        await closure;
      }
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(clientClosures);
    await closeMinimalGatewayServer(wss);
    await close();
  }
}

function mockPeerGateway(peer: AcquisitionPeer, close = peer.close) {
  const server = {
    close,
    startupSettled: Promise.resolve(),
    getTailscaleIngressEndpoint: () => undefined,
  } satisfies import("./server.js").GatewayServer;
  const start = vi.fn(async () => {
    // Mirror the real startup-owned selector for close-order assertions.
    process.env.OPENCLAW_GATEWAY_PORT = String(peer.port);
    return server;
  });
  vi.doMock("./server.js", () => ({
    startGatewayServer: start,
    resetPreparedModelCatalogForTest: vi.fn(),
  }));
  vi.doMock("../test-utils/ports.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../test-utils/ports.js")>()),
    getDeterministicFreePortBlock: async () => peer.port,
  }));
  return start;
}

type CompositeAcquisitionCase = {
  helper: "raw" | "GatewayClient";
  failure: "construction" | "open" | "authentication" | "authentication without close";
  shutdown: "joined" | "rejected";
};

// The disposable fork imports the same assertions without registering sibling cases.
export async function verifyCompositeAcquisition({
  helper,
  failure,
  shutdown,
}: CompositeAcquisitionCase): Promise<void> {
  await withOpenClawTestState(
    {
      label: "composite-acquisition",
      env: { OPENCLAW_GATEWAY_TOKEN: "synthetic-prior-token" },
    },
    async (state) => {
      const behavior =
        failure === "authentication without close"
          ? "reject auth without close"
          : failure === "open"
            ? "reject upgrade"
            : failure === "authentication"
              ? "reject auth"
              : "reply";
      await withAcquisitionPeer(behavior, async (peer) => {
        const closing = createDeferred();
        const release = createDeferred();
        const closeError = new Error("synthetic server close failure");
        mockPeerGateway(peer, async () => {
          closing.resolve();
          await release.promise;
          if (shutdown === "rejected") {
            throw closeError;
          }
          await peer.close();
        });
        const { startServerWithClient, startConnectedServerWithClient } =
          await import("./test-helpers.server.js");
        const { startGatewayWithClient } = await import("./test-helpers.e2e.js");
        const { GatewayClient } = await import("./client.js");
        // oxlint-disable-next-line typescript/unbound-method -- The observer calls the original on its acquired client.
        const stopAndWait = GatewayClient.prototype.stopAndWait;
        let clientStopSettled = false;
        const stopSpy = vi
          .spyOn(GatewayClient.prototype, "stopAndWait")
          .mockImplementation(async function (this: InstanceType<typeof GatewayClient>, options) {
            await stopAndWait.call(this, options);
            clientStopSettled = true;
          });
        const selector = helper === "raw" ? "OPENCLAW_GATEWAY_TOKEN" : "OPENCLAW_GATEWAY_PORT";
        const ownedSelector = helper === "raw" ? "synthetic-owned-token" : String(peer.port);
        const previousSelector = process.env[selector];
        const wsHeaders = failure === "construction" ? { "invalid header": "value" } : undefined;
        const started =
          helper === "GatewayClient"
            ? startGatewayWithClient({
                cfg: {},
                configPath: state.statePath("client-config.json"),
                token: "synthetic-token",
              })
            : failure === "authentication"
              ? startConnectedServerWithClient("synthetic-owned-token")
              : startServerWithClient("synthetic-owned-token", { wsHeaders });
        const acquisition = started.catch((error: unknown) => error);
        try {
          const first = await Promise.race([
            closing.promise.then(() => "closing"),
            acquisition.then(() => "settled"),
          ]);
          expect(first).toBe("closing");
          expect(process.env[selector]).toBe(ownedSelector);
          expect(peer.isListening()).toBe(true);
          // GatewayClient owns a bounded stop; raw helpers promise the transport close event.
          if (helper === "GatewayClient") {
            expect(peer.clients).toHaveLength(1);
            expect(clientStopSettled).toBe(true);
          } else {
            expect(peer.clients.every((client) => peer.closed.has(client))).toBe(true);
          }
          release.resolve();
          const result = await acquisition;
          const originalError = result instanceof AggregateError ? result.errors[0] : result;
          if (failure === "construction") {
            expect(originalError).toMatchObject({ code: "ERR_INVALID_HTTP_TOKEN" });
          } else if (failure === "open") {
            expect(originalError).toBe(peer.errors[0]);
          } else {
            expect(originalError).toMatchObject({
              message: expect.stringContaining("synthetic auth rejection"),
            });
          }
          if (shutdown === "rejected") {
            expect(result).toBeInstanceOf(AggregateError);
            expect(result).toHaveProperty("errors", [originalError, closeError]);
            expect(process.env[selector]).toBe(ownedSelector);
            expect(peer.isListening()).toBe(true);
          } else {
            expect(result).toBe(originalError);
            expect(process.env[selector]).toBe(previousSelector);
            expect(peer.isListening()).toBe(false);
          }
        } finally {
          release.resolve();
          await acquisition;
          stopSpy.mockRestore();
        }
      });
    },
  );
}

async function runRetainedAcquisitionFork(
  scenario: CompositeAcquisitionCase,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "gateway-acquisition-fork-")),
  );
  let joined = false;
  try {
    // Rejected native close permanently retains its owner; each case needs its own worker.
    createVitestResourceOwner(root);
    const require = createRequire(import.meta.url);
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(root, "home"));
    await fs.mkdir(path.join(root, "tmp"));
    await fs.writeFile(
      path.join(root, "fixture.test.ts"),
      `
import { it, vi } from "vitest";
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal()),
  describe: () => {},
}));
const { verifyCompositeAcquisition } = await import(${JSON.stringify(import.meta.filename)});
it("retains a failed acquisition owner", async () => {
  await verifyCompositeAcquisition(${JSON.stringify(scenario)});
});
`,
    );
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      `
import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default defineConfig({
  envDir: false,
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  plugins: sharedVitestConfig.plugins,
  resolve: sharedVitestConfig.resolve,
  test: {
    pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    include: ["fixture.test.ts"],
    testTimeout: sharedVitestConfig.test.testTimeout,
    hookTimeout: sharedVitestConfig.test.hookTimeout,
    deps: sharedVitestConfig.test.deps,
    server: sharedVitestConfig.test.server,
  },
});
`,
    );
    const reportFile = path.join(root, "report.json");
    const output = await runVitestShutdownCommand({
      args: [
        path.join(vitestPackageDir, "vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        path.join(root, "vitest.config.ts"),
        "--configLoader",
        "runner",
        "--reporter=json",
        `--outputFile=${reportFile}`,
      ],
      cwd: repoRoot,
      signal,
      timeoutMs: 90_000,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "home/.openclaw"),
        OPENCLAW_CONFIG_PATH: path.join(root, "home/.openclaw/openclaw.json"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        CI: "1",
        NO_COLOR: "1",
      },
    });
    // The managed command verifies process-tree exit before this root can be released.
    joined = true;
    const diagnostics = `${output.stdout}\n${output.stderr}`;
    expect(output.code, diagnostics).toBe(0);
    expect(JSON.parse(await fs.readFile(reportFile, "utf8")), diagnostics).toMatchObject({
      numPassedTests: 1,
      numFailedTests: 0,
      success: true,
    });
  } finally {
    if (joined) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.warn(`Retained unjoined Gateway acquisition fixture: ${root}`);
    }
  }
}

describe("raw Gateway helper acquisition ownership", () => {
  it.each([
    { helper: "tracked", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "tracked", behavior: "reject upgrade", error: "Unexpected server response: 503" },
    { helper: "tracked", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "webchat", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "webchat", behavior: "upgrade then transport error", error: "invalid opcode 3" },
    { helper: "shared auth", behavior: "hold upgrade", error: "timeout waiting for ws open" },
    { helper: "shared auth", behavior: "no challenge", error: "missing connect.challenge nonce" },
    { helper: "shared auth", behavior: "reject auth", error: "synthetic auth rejection" },
    { helper: "shared auth", behavior: "no response", error: "timeout" },
    { helper: "shared auth", behavior: "transport error", error: "invalid opcode 3" },
    { helper: "shared auth", behavior: "hello then transport error", error: "invalid opcode 3" },
    { helper: "webchat", behavior: "reject auth", error: "synthetic auth rejection" },
    { helper: "webchat", behavior: "transport error", error: "invalid opcode 3" },
    { helper: "webchat", behavior: "hello then transport error", error: "invalid opcode 3" },
    {
      helper: "device request",
      behavior: "no challenge",
      error: "timeout waiting for connect challenge",
    },
    { helper: "device request", behavior: "no response", error: "timeout" },
  ] as const)("$helper owns cleanup after $behavior", async ({ helper, behavior, error }) => {
    await withOpenClawTestState({ label: "raw-acquisition" }, async () => {
      await withAcquisitionPeer(behavior, async (peer) => {
        const { openTrackedWs } = await import("./device-authz.test-helpers.js");
        const { openAuthenticatedGatewayWs } = await import("./shared-auth.test-helpers.js");
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const { connectWebchatClient } = await import("./test-helpers.server.js");
        const { testState } = await import("./test-helpers.runtime-state.js");
        testState.gatewayAuth = { mode: "token", token: "synthetic-token" };
        const acquisition =
          helper === "tracked"
            ? openTrackedWs(peer.port, { "x-acquisition-test": "tracked" })
            : helper === "webchat"
              ? connectWebchatClient({ port: peer.port })
              : helper === "shared auth"
                ? openAuthenticatedGatewayWs(peer.port, "synthetic-token")
                : connectDeviceAuthReq({
                    url: `ws://127.0.0.1:${peer.port}`,
                    token: "synthetic-token",
                  });
        // Observe rejection immediately; none of these rows has an unbounded open wait.
        const failure: unknown = await acquisition.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        if (
          behavior === "upgrade then transport error" ||
          behavior === "hello then transport error"
        ) {
          expect(peer.errors[0], "native error must precede acquisition settlement").toMatchObject({
            code: "WS_ERR_INVALID_OPCODE",
          });
          expect(failure).toBe(peer.errors[0]);
        }
        expect(peer.unownedErrors).toEqual([]);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({ message: expect.stringContaining(error) });
        if (behavior === "no response") {
          expect(failure).toMatchObject({ message: "timeout" });
        }
        expect(peer.isListening(), "a failed socket cannot close its borrowed server").toBe(true);
        if (behavior === "no response" || behavior === "reject auth") {
          expect(peer.requests).toHaveLength(1);
          expect(peer.requests[0]).toMatchObject({
            method: "connect",
            params: { auth: { token: "synthetic-token" } },
          });
        }
        expect(peer.clients).toHaveLength(1);
        const client = peer.clients[0]!;
        expect(client.readyState).toBe(WebSocket.CLOSED);
        expect(peer.closed.has(client)).toBe(true);
        expect(client.listenerCount("open")).toBe(0);
      });
    });
  });

  it("retains the native error until awaited webchat preparation finishes", async () => {
    await withOpenClawTestState({ label: "webchat-preparation" }, async () => {
      await withAcquisitionPeer("reply", async (peer) => {
        const preparing = createDeferred();
        const release = createDeferred();
        const preparationError = new Error("synthetic preparation failure");
        let preparationFinished = false;
        vi.doMock("../infra/device-pairing.js", async (importOriginal) => ({
          ...(await importOriginal<typeof import("../infra/device-pairing.js")>()),
          getPairedDevice: async () => {
            preparing.resolve();
            await release.promise;
            preparationFinished = true;
            throw preparationError;
          },
        }));
        const { connectWebchatClient } = await import("./test-helpers.server.js");
        let settled = false;
        const acquisition = connectWebchatClient({ port: peer.port })
          .finally(() => {
            settled = true;
          })
          .catch((error: unknown) => error);
        try {
          await preparing.promise;
          const transportError = await peer.failTransport();
          await setImmediate();
          const settledDuringPreparation = settled;
          release.resolve();
          expect(await acquisition).toBe(transportError);
          expect(settledDuringPreparation).toBe(false);
          expect(preparationFinished).toBe(true);
          expect(peer.unownedErrors).toEqual([]);
          expect(peer.closed.has(peer.clients[0]!)).toBe(true);
          expect(peer.isListening()).toBe(true);
        } finally {
          release.resolve();
          await acquisition;
        }
      });
    });
  });

  it("restores the token environment when server startup rejects before acquisition", async () => {
    await withOpenClawTestState(
      {
        label: "server-start-rejection",
        env: { OPENCLAW_GATEWAY_TOKEN: "synthetic-prior-token" },
      },
      async () => {
        await withAcquisitionPeer("reply", async (peer) => {
          const startupError = new Error("synthetic server startup failure");
          mockPeerGateway(peer).mockRejectedValue(startupError);
          const { startServerWithClient } = await import("./test-helpers.server.js");
          const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
          await expect(startServerWithClient("synthetic-owned-token")).rejects.toBe(startupError);
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe(previousToken);
          expect(peer.clients).toEqual([]);
        });
      },
    );
  });

  it.for([
    { helper: "raw", failure: "construction", shutdown: "joined" },
    { helper: "raw", failure: "construction", shutdown: "rejected" },
    { helper: "raw", failure: "open", shutdown: "joined" },
    { helper: "raw", failure: "open", shutdown: "rejected" },
    { helper: "raw", failure: "authentication", shutdown: "joined" },
    { helper: "raw", failure: "authentication", shutdown: "rejected" },
    { helper: "GatewayClient", failure: "authentication", shutdown: "joined" },
    { helper: "GatewayClient", failure: "authentication", shutdown: "rejected" },
    { helper: "GatewayClient", failure: "authentication without close", shutdown: "joined" },
    { helper: "GatewayClient", failure: "authentication without close", shutdown: "rejected" },
  ] as const)(
    "$helper retains server ownership after $failure failure and $shutdown shutdown",
    async (scenario, context) => {
      if (scenario.helper === "raw" && scenario.shutdown === "rejected") {
        const run = runRetainedAcquisitionFork(scenario, context.signal);
        context.onTestFinished(() => run);
        await run;
      } else {
        await verifyCompositeAcquisition(scenario);
      }
    },
  );

  it.each(["success", "rejection"] as const)(
    "owns returned-server selectors through close %s",
    async (shutdown) => {
      await withOpenClawTestState(
        {
          label: "returned-client-server",
          env: { OPENCLAW_GATEWAY_PORT: "24680" },
        },
        async (state) => {
          await withAcquisitionPeer("reply", async (peer) => {
            const closeError = new Error("synthetic returned-server close failure");
            let rejectClose = shutdown === "rejection";
            mockPeerGateway(peer, async () => {
              if (rejectClose) {
                throw closeError;
              }
              await peer.close();
            });
            const { startGatewayWithClient } = await import("./test-helpers.e2e.js");
            const configPath = state.statePath("client-config.json");
            const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
            const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
            const started = await startGatewayWithClient({
              cfg: {},
              configPath,
              token: "synthetic-token",
            });
            try {
              await started.client.stopAndWait();
              if (shutdown === "rejection") {
                await expect(started.server.close()).rejects.toBe(closeError);
                expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(peer.port));
                expect(process.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
                expect(peer.isListening()).toBe(true);
                rejectClose = false;
              }
              await started.server.close();
              expect(process.env.OPENCLAW_CONFIG_PATH).toBe(previousConfig);
              expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(previousPort);
              expect(peer.isListening()).toBe(false);
            } finally {
              await started.client.stopAndWait();
              rejectClose = false;
              await started.server.close();
            }
          });
        },
      );
    },
  );

  it("joins the one-shot device socket close before returning its response", async () => {
    await withOpenClawTestState({ label: "device-acquisition-response" }, async () => {
      await withAcquisitionPeer("reply", async (peer) => {
        const { connectDeviceAuthReq } = await import("./test-helpers.e2e.js");
        const response = await connectDeviceAuthReq({
          url: `ws://127.0.0.1:${peer.port}`,
          token: "synthetic-token",
        });
        expect(response).toMatchObject({ type: "res", id: "c1", ok: true });
        expect(peer.requests).toHaveLength(1);
        expect(peer.requests[0]).toMatchObject({
          params: { auth: { token: "synthetic-token" }, device: { nonce: "test-nonce" } },
        });
        expect(peer.clients).toHaveLength(1);
        expect(peer.closed.has(peer.clients[0]!)).toBe(true);
        expect(peer.clients[0]!.readyState).toBe(WebSocket.CLOSED);
      });
    });
  });
});
