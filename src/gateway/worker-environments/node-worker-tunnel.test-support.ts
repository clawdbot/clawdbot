import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { SpawnResult } from "../../process/exec.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export const BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.13",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};

export function environment(): WorkerEnvironmentRecord {
  return {
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "node-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: { ...BUILD, installKind: "bundle" },
    ownerEpoch: 2,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "device-lease",
    sshEndpoint: null,
  };
}

export function transport(): NodeWorkerSupervisorTransport {
  return {
    hasCurrentRunner: () => true,
    listCurrentNodes: async () => [
      {
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "pairing-1",
        pairingGeneration: "generation-1",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        commands: ["system.run"],
      },
    ],
    isCurrent: () => true,
    invoke: async () => ({ ok: false, error: { code: "UNAVAILABLE" } }),
  };
}

export function startRequest() {
  return {
    environmentId: "environment-1",
    ownerEpoch: 2,
    deviceId: "node-1",
    sessionId: "session-1",
    expectedBuild: BUILD,
  };
}

export function workspaceTransfer(): NodeWorkspaceTransferService {
  return {
    close: vi.fn(async () => {}),
    revoke: vi.fn(),
  } as unknown as NodeWorkspaceTransferService;
}

export function workspaceCommandPayload(workspaceDir: string, result: Partial<SpawnResult>) {
  return JSON.stringify({
    workspaceDir,
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...result,
  });
}
