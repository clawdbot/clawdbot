import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createWorkerSupervisorNodeClient(connId = "conn-1"): GatewayWsClient {
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
    } as unknown as GatewayWsClient["connect"],
  };
}

function createNodeHandlerContext() {
  return {
    broadcast: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    invalidateClientsForDevice: vi.fn(),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: {
      get: vi.fn(),
      listConnected: vi.fn(() => []),
      listConnectedForPairingStates: vi.fn(() => []),
      getActiveNode: vi.fn(),
      updateSurface: vi.fn(),
      updateNodeSkills: vi.fn(),
    },
  };
}

export function createNodeHandlerClient(
  scopes: string[],
  deviceId?: string,
  opts?: { isDeviceTokenAuth?: boolean },
) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

export function createNodeHandlerOptions(
  params: unknown,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): {
  context: ReturnType<typeof createNodeHandlerContext>;
  opts: GatewayRequestHandlerOptions;
  respond: ReturnType<typeof vi.fn>;
} {
  const context = createNodeHandlerContext();
  const respond = vi.fn();
  const opts = {
    req: { type: "req", id: "req-1", method: "node.pair.remove", params },
    params,
    client: createNodeHandlerClient(["operator.pairing", "operator.admin"]),
    isWebchatConnect: () => false,
    respond,
    context,
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return { context, opts, respond };
}

export async function pairAndroidNodeDevice(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: [] },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}
