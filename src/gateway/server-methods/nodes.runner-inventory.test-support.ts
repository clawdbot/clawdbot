import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { GatewayWsClient } from "../server/ws-types.js";

export function createWorkerSupervisorNodeClient(
  connId = "conn-1",
  workerRuns?: WorkerAdmissionHandshake,
): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
      device: { id: "node-1" },
      caps: [],
      commands: ["system.run"],
      ...(workerRuns ? { workerRuns } : {}),
    } as unknown as GatewayWsClient["connect"],
  };
}
