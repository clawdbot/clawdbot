import path from "node:path";
import { expect, test, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeConfigFile } from "../config/config.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { withTimeout } from "../infra/fs-safe.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { markGatewayRestartDraining } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { respondToNodeShutdown } from "./node-shutdown.test-support.js";
import { createGatewayKernel } from "./server-kernel.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer, writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import { sessionStoreEntry } from "./test/server-sessions.test-helpers.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import {
  BUNDLE_HASH,
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

installGatewayTestHooks({ scope: "suite" });

test.for(["direct", "restart"] as const)(
  "settles rootless worker cleanup and joins an unanswered invoke during %s Gateway shutdown",
  async (mode, { signal }) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("node shutdown proof requires an isolated Gateway state directory");
    }
    testState.sessionStorePath = path.join(stateDir, "node-shutdown-sessions.json");
    const pairedNode = await pairDeviceIdentity({
      name: "node-shutdown",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const pairing = await requestNodePairing({
      nodeId: pairedNode.identity.deviceId,
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["camera.list"],
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });
    await writeConfigFile({ gateway: { nodes: { commands: { allow: ["camera.list"] } } } });

    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    const createKernel = createGatewayKernel;
    const factory = vi
      .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
      .mockImplementation(async (...args) => {
        kernel = await createKernel(...args);
        return kernel;
      });
    const previousMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    let started: Awaited<ReturnType<typeof startServer>>;
    try {
      delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      started = await startServer("secret");
    } catch (error) {
      factory.mockRestore();
      throw error;
    } finally {
      if (previousMinimalGateway === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
      }
    }
    const { port, server } = started;
    let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let closing: Promise<void> | undefined;
    let ordinaryRequest: Promise<unknown> | undefined;
    const stopped = createDeferredCore<unknown>();
    const stopRequested = createDeferredCore();
    const releaseStopReply = createDeferredCore();
    const ordinaryDispatched = createDeferredCore();
    const finalizerEntered = createDeferredCore();
    const releaseFinalizer = createDeferredCore();
    const stopRequests: unknown[] = [];
    const stopDependencies = vi.fn(async () => {});
    const closeSettled = vi.fn();
    const unblock = () => {
      releaseStopReply.resolve();
      releaseFinalizer.resolve();
    };
    signal.addEventListener("abort", unblock, { once: true });
    void stopped.promise.catch(() => undefined);

    try {
      await runQaGatewayFixture(
        async () => {
          await server.startupSettled;
          if (!kernel) {
            throw new Error("expected the real Gateway kernel");
          }
          const invoke = kernel.nodeRegistry.invoke.bind(kernel.nodeRegistry);
          vi.spyOn(kernel.nodeRegistry, "invoke").mockImplementation(async (params) => {
            const result = await invoke(params);
            if (params.command === "camera.list") {
              finalizerEntered.resolve();
              await releaseFinalizer.promise;
            }
            return result;
          });
          kernel.registerGatewayLifetimeSidecars([{ stop: stopDependencies }]);
          node = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token: "secret",
            role: "node",
            clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
            clientDisplayName: "shutdown worker node",
            mode: GATEWAY_CLIENT_MODES.NODE,
            platform: "linux",
            deviceFamily: "Linux",
            scopes: [],
            commands: ["camera.list"],
            deviceIdentity: pairedNode.identity,
            onEvent: (event) => {
              const respondingNode = node;
              if (event.event !== "node.invoke.request" || !event.payload || !respondingNode) {
                return;
              }
              const frame = event.payload as {
                id: string;
                nodeId: string;
                command: string;
                paramsJSON: string;
              };
              if (frame.command === "camera.list") {
                ordinaryDispatched.resolve();
                return;
              }
              const result =
                frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND
                  ? (async () => {
                      stopRequested.resolve();
                      await releaseStopReply.promise;
                      return respondToNodeShutdown(respondingNode, frame);
                    })()
                  : respondToNodeShutdown(respondingNode, frame);
              if (!result) {
                stopped.reject(new Error(`unexpected shutdown command: ${frame.command}`));
                return;
              }
              if (frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
                stopRequests.push(JSON.parse(frame.paramsJSON));
                void result.then(stopped.resolve, stopped.reject);
              } else {
                void result.catch(() => undefined);
              }
            },
          });
          await node.request("node.runnerInventory.update", {
            protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
            workerHost: {
              enabled: true,
              capacity: { total: 1, available: 1 },
              environmentSession: 1,
            },
          });
          await writeSessionStore({
            entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
          });
          const environmentId = "environment-node-shutdown";
          const environments = createWorkerEnvironmentStore();
          environments.createIntent({
            environmentId,
            providerId: DEVICE_WORKER_PROVIDER_ID,
            profileId: `device:${pairedNode.identity.deviceId}`,
            profileSnapshot: {
              install: "bundle",
              settings: { device: pairedNode.identity.deviceId },
            },
            provisionOperationId: "provision-node-shutdown",
          });
          environments.transition({ environmentId, from: "requested", to: "provisioning" });
          environments.transition({
            environmentId,
            from: "provisioning",
            to: "ready",
            patch: {
              leaseId: "lease-node-shutdown",
              nodeDeviceId: pairedNode.identity.deviceId,
              sharedHost: true,
              bootstrapReceipt: {
                bundleHash: BUNDLE_HASH,
                openclawVersion: "2026.8.19",
                protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
                installKind: "bundle",
              },
              credential: {
                credentialHash: hashWorkerCredential("node-shutdown-ready-fixture"),
                sessionId: null,
                rpcSetVersion: 1,
                expiresAtMs: Date.now() + 60_000,
              },
            },
          });
          const attached = environments.transition({
            environmentId,
            from: "ready",
            to: "attached",
            patch: {
              attachedSessionIds: [REQUEST.sessionId],
              credential: {
                credentialHash: hashWorkerCredential("node-shutdown-fixture"),
                sessionId: REQUEST.sessionId,
                rpcSetVersion: 1,
                expiresAtMs: Date.now() + 60_000,
              },
            },
          });
          const placements = createWorkerSessionPlacementStore();
          seedActivePlacement(placements, { environmentId, ownerEpoch: attached.ownerEpoch });
          expect(placements.get(REQUEST.sessionId)).toMatchObject({
            state: "active",
            turnClaim: null,
          });

          operator = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token: "secret",
            role: "operator",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          ordinaryRequest = operator
            .request(
              "node.invoke",
              {
                nodeId: pairedNode.identity.deviceId,
                command: "camera.list",
                timeoutMs: 0,
                idempotencyKey: "shutdown-unanswered-invoke",
              },
              { timeoutMs: 10_000 },
            )
            .catch((error: unknown) => error);
          await withTimeout(ordinaryDispatched.promise, 5_000, "ordinary node invocation");

          // Cleanup has no request root. The unanswered invoke must not block the owner
          // that needs this node to acknowledge physical worker shutdown first.
          if (mode === "restart") {
            markGatewayRestartDraining();
          }
          closing = server.close({ reason: "gateway stopping" });
          void closing.then(closeSettled, closeSettled);
          await withTimeout(stopRequested.promise, 5_000, "worker stop dispatch");
          const reconnect = connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token: "secret",
            role: "node",
            clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
            mode: GATEWAY_CLIENT_MODES.NODE,
            platform: "linux",
            deviceFamily: "Linux",
            deviceIdentity: pairedNode.identity,
            timeoutMs: 5_000,
          });
          if (mode === "restart") {
            await expect(reconnect).rejects.toMatchObject({
              name: "GatewayClientRequestError",
              message:
                "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
              gatewayCode: "UNAVAILABLE",
              retryable: true,
              details: { reason: "websocket-upgrade-rejected", httpStatus: 503 },
            });
          } else {
            await expect(reconnect).rejects.toThrow("gateway closed during connect (1006)");
          }
          expect(closeSettled).not.toHaveBeenCalled();
          releaseStopReply.resolve();
          await expect(withTimeout(stopped.promise, 5_000, "node shutdown reply")).resolves.toEqual(
            {
              ok: true,
            },
          );
          await withTimeout(finalizerEntered.promise, 5_000, "ordinary invocation finalizer");
          expect(stopDependencies).not.toHaveBeenCalled();
          expect(closeSettled).not.toHaveBeenCalled();
          releaseFinalizer.resolve();
          await withTimeout(closing, 5_000, "Gateway shutdown");
          expect(stopDependencies).toHaveBeenCalledOnce();
          expect(stopRequests).toEqual([
            {
              gatewayNamespace: expect.any(String),
              environmentId,
              sessionId: REQUEST.sessionId,
              ownerEpoch: attached.ownerEpoch,
            },
          ]);
        },
        async () => {
          // The original node remains available to acknowledge physical worker shutdown.
          unblock();
          await (closing ?? server.close());
        },
        () => node?.stopAndWait({ timeoutMs: 1_000 }),
        () => operator?.stopAndWait({ timeoutMs: 1_000 }),
        async () => {
          await ordinaryRequest;
        },
      );
    } finally {
      factory.mockRestore();
      vi.restoreAllMocks();
      signal.removeEventListener("abort", unblock);
    }
  },
);
