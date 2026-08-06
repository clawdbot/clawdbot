import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { approveNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway } from "./call.js";
import { openTrackedWs, pairDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const {
  cleanup: cleanupNodePairingTestState,
  makeStateDir: makeNodePairingStateDir,
  seedNodeDevice,
  setup: setupNodePairingTestState,
} = createNodePairingTestState("openclaw-node-pair-authz-diagnostics-");

describe("gateway node pairing authorization", () => {
  beforeAll(async () => {
    await setupNodePairingTestState();
  });

  afterAll(async () => {
    await cleanupNodePairingTestState();
  });

  describeWithGatewayServer("pending diagnostics scopes", (getStarted) => {
    test("shows pending pairing records to direct-local backend shared-auth callers", async () => {
      const pendingOnlyNodeId = "node-local-backend-pending";
      await seedNodeDevice(pendingOnlyNodeId);
      const pending = await requestNodePairing({
        nodeId: pendingOnlyNodeId,
        platform: "macos",
        commands: ["system.run"],
      });

      const listed = await callGateway<{
        nodes?: Array<{
          nodeId: string;
          approvalState?: string;
          pendingRequestId?: string;
        }>;
      }>({
        config: {
          gateway: {
            mode: "local",
            bind: "loopback",
            port: getStarted().port,
            auth: { mode: "token", token: "secret" },
          },
        },
        method: "node.list",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
        timeoutMs: 2_000,
      });

      expect(listed.nodes).toContainEqual(
        expect.objectContaining({
          nodeId: pendingOnlyNodeId,
          approvalState: "pending-approval",
          pendingRequestId: pending.request.requestId,
        }),
      );
    });

    test("shows only the caller's pending request id to read-only callers", async () => {
      const pairedNodeId = "node-read-only-paired";
      const pendingOnlyNodeId = "node-read-only-pending";
      const visiblePendingNode = await pairDeviceIdentity({
        name: "node-read-only-visible-pending",
        role: "operator",
        scopes: ["operator.read"],
      });
      await pairDeviceIdentity({
        name: "node-read-only-visible-pending",
        role: "node",
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      });
      await seedNodeDevice(pairedNodeId);
      const initial = await requestNodePairing({
        nodeId: pairedNodeId,
        platform: "macos",
        commands: ["screen.snapshot"],
      });
      await approveNodePairing(initial.request.requestId, {
        callerScopes: ["operator.pairing", "operator.write"],
      });
      await requestNodePairing({
        nodeId: pairedNodeId,
        platform: "macos",
        commands: ["screen.snapshot", "system.run"],
      });
      await seedNodeDevice(pendingOnlyNodeId);
      await requestNodePairing({
        nodeId: pendingOnlyNodeId,
        platform: "macos",
        commands: ["system.run"],
      });
      const visiblePending = await requestNodePairing({
        nodeId: visiblePendingNode.identity.deviceId,
        platform: "android",
        commands: ["device.status"],
      });

      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/read-only.sqlite`,
        });

        type NodeDiagnostics = {
          nodeId: string;
          approvalState?: string;
          pendingRequestId?: string;
          pendingDeclaredCommands?: string[];
        };
        const listed = await rpcReq<{ nodes?: NodeDiagnostics[] }>(ws, "node.list", {});
        expect(listed.ok).toBe(true);
        const nodes = listed.payload?.nodes ?? [];
        // Pending surfaces now attach to paired devices, so the row is visible
        // to read-only callers but its approval target stays redacted.
        expect(nodes.find((node) => node.nodeId === pendingOnlyNodeId)).toEqual(
          expect.objectContaining({
            nodeId: pendingOnlyNodeId,
            approvalState: "pending-approval",
          }),
        );
        expect(nodes.find((node) => node.nodeId === pendingOnlyNodeId)).not.toHaveProperty(
          "pendingRequestId",
        );
        expect(nodes.find((node) => node.nodeId === pendingOnlyNodeId)).not.toHaveProperty(
          "pendingDeclaredCommands",
        );
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).toEqual(
          expect.objectContaining({
            nodeId: pairedNodeId,
            approvalState: "pending-reapproval",
          }),
        );
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
          "pendingRequestId",
        );
        expect(nodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
          "pendingDeclaredCommands",
        );
        expect(nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId)).toEqual(
          expect.objectContaining({
            nodeId: visiblePendingNode.identity.deviceId,
            approvalState: "pending-approval",
          }),
        );
        expect(
          nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
        ).not.toHaveProperty("pendingRequestId");
        expect(
          nodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
        ).not.toHaveProperty("pendingDeclaredCommands");

        const described = await rpcReq<NodeDiagnostics>(ws, "node.describe", {
          nodeId: pairedNodeId,
        });
        expect(described.payload).toEqual(
          expect.objectContaining({
            nodeId: pairedNodeId,
            approvalState: "pending-reapproval",
          }),
        );
        expect(described.payload).not.toHaveProperty("pendingRequestId");
        expect(described.payload).not.toHaveProperty("pendingDeclaredCommands");

        const describedVisiblePending = await rpcReq<NodeDiagnostics>(ws, "node.describe", {
          nodeId: visiblePendingNode.identity.deviceId,
        });
        expect(describedVisiblePending.payload).toEqual(
          expect.objectContaining({
            nodeId: visiblePendingNode.identity.deviceId,
            approvalState: "pending-approval",
          }),
        );
        expect(describedVisiblePending.payload).not.toHaveProperty("pendingRequestId");
        expect(describedVisiblePending.payload).not.toHaveProperty("pendingDeclaredCommands");

        const pendingOnly = await rpcReq<NodeDiagnostics>(ws, "node.describe", {
          nodeId: pendingOnlyNodeId,
        });
        expect(pendingOnly.ok).toBe(true);
        expect(pendingOnly.payload).not.toHaveProperty("pendingRequestId");
        expect(pendingOnly.payload).not.toHaveProperty("pendingDeclaredCommands");

        const selfWs = await openTrackedWs(getStarted().port);
        try {
          await connectOk(selfWs, {
            token: "secret",
            scopes: ["operator.read"],
            deviceIdentityPath: visiblePendingNode.identityPath,
          });
          const selfListed = await rpcReq<{ nodes?: NodeDiagnostics[] }>(selfWs, "node.list", {});
          const selfNodes = selfListed.payload?.nodes ?? [];
          expect(
            selfNodes.find((node) => node.nodeId === visiblePendingNode.identity.deviceId),
          ).toEqual(
            expect.objectContaining({
              approvalState: "pending-approval",
              pendingRequestId: visiblePending.request.requestId,
            }),
          );
          expect(selfNodes.find((node) => node.nodeId === pairedNodeId)).not.toHaveProperty(
            "pendingRequestId",
          );

          const selfDescribed = await rpcReq<NodeDiagnostics>(selfWs, "node.describe", {
            nodeId: visiblePendingNode.identity.deviceId,
          });
          expect(selfDescribed.payload).toEqual(
            expect.objectContaining({
              approvalState: "pending-approval",
              pendingRequestId: visiblePending.request.requestId,
            }),
          );
        } finally {
          selfWs.close();
        }
      } finally {
        ws.close();
      }
    });
  });
});
