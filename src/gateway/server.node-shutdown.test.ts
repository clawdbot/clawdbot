import path from "node:path";
import { expect, test } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { withTimeout } from "../infra/fs-safe.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { markGatewayRestartDraining } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
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

test("settles an idle paired worker's rootless stop reply during Gateway shutdown", async () => {
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
    commands: [],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });

  const previousMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    started = await startServer("secret");
  } finally {
    if (previousMinimalGateway === undefined) {
      delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    } else {
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
    }
  }
  const { port, server } = started;
  let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let closing: Promise<void> | undefined;
  const stopped = createDeferredCore<unknown>();
  const stopRequests: unknown[] = [];
  void stopped.promise.catch(() => undefined);

  try {
    await server.startupSettled;
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
      commands: [],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload) {
          return;
        }
        const frame = event.payload as {
          id: string;
          nodeId: string;
          command: string;
          paramsJSON: string;
        };
        const isStop = frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND;
        if (!isStop && frame.command !== NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
          stopped.reject(new Error(`unexpected shutdown command: ${frame.command}`));
          return;
        }
        if (isStop) {
          stopRequests.push(JSON.parse(frame.paramsJSON));
        }
        const result = node!.request(
          "node.invoke.result",
          {
            id: frame.id,
            nodeId: frame.nodeId,
            ok: true,
            payloadJSON: JSON.stringify(
              isStop ? null : { applied: true, deleted: 0, hasMore: false },
            ),
          },
          { timeoutMs: 5_000 },
        );
        if (isStop) {
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
      profileSnapshot: { install: "bundle", settings: { device: pairedNode.identity.deviceId } },
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
    expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });

    // Stop has no request root: it is admitted only by the exact environment cleanup owner.
    markGatewayRestartDraining();
    closing = server.close({ reason: "gateway stopping" });
    await expect(withTimeout(stopped.promise, 5_000, "node shutdown reply")).resolves.toEqual({
      ok: true,
    });
    await withTimeout(closing, 5_000, "Gateway shutdown");
    expect(stopRequests).toEqual([
      {
        gatewayNamespace: expect.any(String),
        environmentId,
        sessionId: REQUEST.sessionId,
        ownerEpoch: attached.ownerEpoch,
      },
    ]);
  } finally {
    // Disconnect also settles the pending invoke on the failing baseline; no 60s cleanup wait.
    await node?.stopAndWait({ timeoutMs: 1_000 });
    await (closing ?? server.close());
  }
});
