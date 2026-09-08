import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  WORKER_PROTOCOL_FEATURES,
} from "../../../packages/gateway-protocol/src/index.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import { WorkerConnection } from "../../worker/worker-connection.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import {
  attachWorkerWsMessageHandler,
  type WorkerConnectionService,
} from "../server/ws-connection/worker-connection.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createWorkerComputerService } from "./computer-transport.js";
import {
  COMPUTER_USE,
  connectionIdentity,
  createHarness,
} from "./computer-transport.test-support.js";
import { createWorkerComputerRpc } from "./worker-turn-computer-rpc.js";

describe("worker computer connection lifetime", () => {
  afterEach(() => {
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
  });

  it("keeps semantic tool rejections recoverable without retiring the execution", async () => {
    const requestComputer = vi.fn<
      Parameters<typeof createWorkerComputerTool>[0]["requestComputer"]
    >(async () => ({
      type: "res",
      id: "denied",
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "policy denied this action",
        details: { reason: "gateway-unavailable" },
      },
    }));
    const tool = createWorkerComputerTool({
      descriptor: { nodeId: "desktop-node", computerUse: COMPUTER_USE },
      runId: "semantic-rejection",
      requestComputer,
      registerRunCleanup: undefined,
    });
    for (const id of ["first", "retry"]) {
      await expect(tool.execute(id, { action: "type", text: "denied" })).rejects.toThrow(
        "policy denied this action",
      );
    }
    expect(requestComputer).toHaveBeenCalledTimes(2);
  });

  it.each(["policy", "pairing", "completed", "ordinary-close"])(
    "fences desktop input across $0 boundaries, while durable work survives",
    async (boundary) => {
      const h = createHarness();
      const service = createWorkerComputerService(h.options);
      const computer = await service.prepare(h.claim);
      if (!computer) {
        throw new Error("Expected session computer");
      }
      computer.bind(h.run);
      const identity = {
        ...connectionIdentity(h),
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const rpc = createWorkerComputerRpc({
        execute: service.execute,
        validate: () => ({ ok: true }),
      });
      const entered = createDeferred();
      const resume = createDeferred();
      const disconnected = createDeferred();
      const durableEntered = createDeferred();
      const durableResume = createDeferred();
      const durableDone = createDeferred();
      let durableSignal: AbortSignal | undefined;
      let pendingComputer: ReturnType<typeof rpc> | undefined;
      let freshComputer: Promise<unknown> | undefined;
      let computerRequests = 0;
      const serverService: WorkerConnectionService = {
        admitWorker: async () => ({ ok: true, identity }),
        validateWorkerConnection: () => null,
        commitTranscript: async () => ({ ok: true, result: { entryIds: [], newLeafId: "unused" } }),
        pushLiveEvent: async () => ({ ok: true, result: { ackedSeq: 0 } }),
        executeComputer: (who, request, signal) => {
          computerRequests += 1;
          return (pendingComputer = rpc(who, request, signal));
        },
        executeSessionTool: async (_who, _tool, _request, signal) => {
          durableSignal = signal;
          durableEntered.resolve();
          await durableResume.promise;
          durableDone.resolve();
          return { ok: true, result: { resultJson: "{}" } };
        },
      };
      const connectionWork = new GatewayConnectionWork();
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (typeof address !== "object" || !address) {
        throw new Error("Expected TCP listener");
      }
      server.on("connection", (socket) => {
        let client: GatewayWsClient | null = null;
        let closed = false;
        const cleanup = attachWorkerWsMessageHandler({
          socket,
          connectionWork,
          connId: "fixture-connection",
          service: serverService,
          publicAdmission: { clientIp: "127.0.0.1", rateLimiter: undefined },
          send: (frame) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(frame));
            }
          },
          close: (code, reason) => socket.close(code, reason),
          isClosed: () => closed,
          getClient: () => client,
          setClient: (value) => {
            client = value;
            return true;
          },
          clearHandshakeTimer: vi.fn(),
          setHandshakeState: vi.fn(),
          advanceHandshakePhase: vi.fn(),
          setCloseCause: vi.fn(),
          setLastFrameMeta: vi.fn(),
          logGateway: { warn: vi.fn() },
          logWsControl: { warn: vi.fn() },
        });
        socket.once("close", () => {
          closed = true;
          cleanup();
          disconnected.resolve();
        });
      });
      const connection = new WorkerConnection({
        endpoint: {
          kind: "websocket",
          url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
        },
        requestTimeoutMs: 1000,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
        connectParams: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: GATEWAY_CLIENT_IDS.WORKER,
            version: "2026.8.1",
            platform: "linux",
            mode: GATEWAY_CLIENT_MODES.WORKER,
          },
          role: "worker",
          admission: {
            environmentId: identity.environmentId,
            credential: "worker-fixture-credential",
            sessionId: h.claim.sessionId,
            runId: h.claim.runId,
            ownerEpoch: identity.ownerEpoch,
            rpcSetVersion: identity.rpcSetVersion,
            handshake: {
              bundleHash: "a".repeat(64),
              openclawVersion: "2026.8.1",
              protocolFeatures: identity.protocolFeatures,
            },
          },
        },
      });
      const cleanups: Array<(reason: string) => Promise<void>> = [];
      const tool = createWorkerComputerTool({
        descriptor: computer.descriptor,
        runId: h.claim.runId,
        requestComputer: (request) => connection.requestComputer(request),
        registerRunCleanup: (close) => cleanups.push(close),
      });
      try {
        await connection.start();
        const durable = connection
          .requestSessionsSend({
            toolCallId: "durable-send",
            sessionKey: "agent:main:child",
            message: "continue",
          })
          .catch((error: unknown) => error);
        await durableEntered.promise;
        if (boundary === "ordinary-close") {
          const readComputerEffects = () => ({
            computerRequests,
            nativeExecutions: h.nativeExecutionIds.length,
            inputs: h.privateInvoke.mock.calls
              .map(([invocation]) =>
                parseNodeWorkerComputerInput(JSON.stringify(invocation.params)),
              )
              .filter((input) => input.operation === "act"),
          });
          await tool.execute("before-close", { action: "type", text: "allowed before close" });
          const beforeClose = readComputerEffects();
          expect(beforeClose).toMatchObject({
            computerRequests: 2,
            nativeExecutions: 2,
            inputs: [
              { operation: "act", params: { action: "type", text: "allowed before close" } },
            ],
          });
          expect(server.clients.size).toBe(1);
          const workerSocket = [...server.clients][0];
          if (!workerSocket) {
            throw new Error("Expected the admitted worker socket");
          }
          const received = createDeferred<string>();
          workerSocket.once("message", (data) => received.resolve(rawDataToString(data)));
          connectionWork.beginClose();
          expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");
          expect(isGatewayRestartDraining()).toBe(false);
          freshComputer = tool
            .execute("after-close", { action: "type", text: "must not type after close" })
            .catch((error: unknown) => error);
          const frame: unknown = JSON.parse(await received.promise);
          expect(frame).toMatchObject({
            type: "req",
            method: "worker.computer",
            params: {
              command: "computer.act",
              paramsJson: expect.stringContaining("must not type after close"),
            },
          });
          // Receipt alone does not settle async dispatch. A control round trip proves
          // the socket stays live while the pre-close request still holds the drain.
          const draining = connectionWork.drain();
          const drained = vi.fn();
          void draining.then(drained, drained);
          const pong = once(workerSocket, "pong");
          workerSocket.ping("held-durable");
          await pong;
          expect(drained).not.toHaveBeenCalled();
          durableResume.resolve();
          await durableDone.promise;
          await draining;
          expect(await durable).toMatchObject({ ok: true });
          expect(durableSignal).toBeUndefined();
          expect(workerSocket.readyState).toBe(WebSocket.OPEN);
          expect(h.options.placements.validateTurnClaim(h.claim)).toBe(true);
          expect(validateAgentRunDelegatedAuthority(h.authority)).toBe(true);
          expect(readComputerEffects()).toEqual(beforeClose);
          return;
        }
        const pause = async () => {
          entered.resolve();
          await resume.promise;
        };
        if (boundary === "completed") {
          await tool.execute("completed", { action: "type", text: "allowed" });
          expect(h.nativeExecutionIds).toHaveLength(2);
          // No computer request remains pending. Socket closure must still release
          // the captured execution, and shutdown must join its eventual close ACK.
          h.state.afterDispatch = pause;
          for (const socket of server.clients) {
            socket.close(1000);
          }
          await disconnected.promise;
          await vi.waitFor(() => {
            expect(h.privateInvoke.mock.calls.at(-1)?.[0].params).toMatchObject({
              operation: "close",
              executionId: h.nativeExecutionIds[0],
            });
          });
        } else {
          if (boundary === "policy") {
            h.state.beforePolicy = pause;
          } else {
            h.state.beforeDispatch = pause;
          }
          const failed = tool
            .execute("deadline", { action: "type", text: "must not type" })
            .catch((error: unknown) => error);
          await entered.promise;
          expect(await failed).toMatchObject({ message: "worker computer response timed out" });
          await disconnected.promise;
        }
        expect(h.options.placements.validateTurnClaim(h.claim)).toBe(true);
        expect(validateAgentRunDelegatedAuthority(h.authority)).toBe(true);
        if (boundary !== "completed") {
          resume.resolve();
          await pendingComputer;
        }
        h.state.beforePolicy = undefined;
        h.state.beforeDispatch = undefined;
        await connection.waitForReady();
        const retained = await tool
          .execute("retained", { action: "type", text: "still forbidden" })
          .catch((error: unknown) => error);
        durableResume.resolve();
        await durableDone.promise;
        expect(await durable).toMatchObject({ ok: true });
        expect(durableSignal).toBeUndefined();
        expect(retained).toBeInstanceOf(Error);
        if (boundary !== "completed") {
          await service.close();
        }
        expect({ computerRequests, nativeExecutions: h.nativeExecutionIds.length }).toEqual({
          computerRequests: boundary === "completed" ? 3 : 1,
          nativeExecutions: boundary === "completed" ? 3 : 1,
        });
        if (boundary === "completed") {
          expect(retained).toMatchObject({ message: expect.stringContaining("start a new turn") });
          const stopping = service.close();
          const stopped = vi.fn();
          void stopping.then(stopped, stopped);
          await Promise.resolve();
          await Promise.resolve();
          expect(stopped).not.toHaveBeenCalled();
          resume.resolve();
          await stopping;
        }
      } finally {
        resume.resolve();
        durableResume.resolve();
        await Promise.allSettled(cleanups.map((close) => close("test finished")));
        await service.close();
        await connection.stop();
        await freshComputer;
        for (const socket of server.clients) {
          socket.terminate();
        }
        connectionWork.beginClose();
        await connectionWork.drain();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      expect(h.nativeExecutionIds).toHaveLength(boundary === "completed" ? 3 : 1);
      expect(h.privateInvoke.mock.calls.at(-1)?.[0].params).toMatchObject({ operation: "close" });
    },
  );
});
