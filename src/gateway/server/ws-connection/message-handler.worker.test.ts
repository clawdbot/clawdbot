import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  type WorkerAdmissionFailureReason,
  type WorkerConnectParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import { createGatewayWsTestSocket } from "../ws-connection.test-helpers.js";
import type { GatewayWsClient } from "../ws-types.js";
import { attachWorkerWsMessageHandler, type WorkerConnectionService } from "./worker-connection.js";

const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const HANDSHAKE = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.11",
  protocolFeatures: ["worker-heartbeat-v1"],
};
const WORKER_CONNECT: WorkerConnectParams = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "2026.7.11",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission: {
    environmentId: "worker-1",
    credential: CREDENTIAL,
    sessionId: null,
    ownerEpoch: 1,
    rpcSetVersion: 1,
    handshake: HANDSHAKE,
  },
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "worker-1",
  credentialHash: "h".repeat(43),
  bundleHash: HANDSHAKE.bundleHash,
  sessionId: null,
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: [...HANDSHAKE.protocolFeatures],
  credentialExpiresAtMs: Date.now() + 60_000,
};
const cleanups: Array<() => void> = [];

function createLogger() {
  return { warn: vi.fn() };
}

function attachHarness(
  options: {
    admissionFailure?: WorkerAdmissionFailureReason;
    validationFailure?: ReturnType<WorkerConnectionService["validateWorkerConnection"]>;
  } = {},
) {
  const socket = createGatewayWsTestSocket();
  const responses: unknown[] = [];
  const close = vi.fn();
  const service = {
    admitWorker: vi.fn(async () =>
      options.admissionFailure
        ? { ok: false as const, reason: options.admissionFailure }
        : { ok: true as const, identity: IDENTITY },
    ),
    validateWorkerConnection: vi.fn(() => options.validationFailure ?? null),
  } as WorkerConnectionService;
  let client: GatewayWsClient | null = null;
  const setClient = vi.fn((next: GatewayWsClient) => {
    client = next;
    return true;
  });
  const logGateway = createLogger();
  const logWsControl = createLogger();
  const cleanup = attachWorkerWsMessageHandler({
    socket: socket as unknown as WebSocket,
    connId: "worker-connection",
    service,
    send: (frame) => responses.push(frame),
    close,
    isClosed: () => false,
    clearHandshakeTimer: vi.fn(),
    getClient: () => client,
    setClient,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause: vi.fn(),
    setLastFrameMeta: vi.fn(),
    logGateway,
    logWsControl,
  });
  cleanups.push(cleanup);
  const send = (frame: unknown) => socket.emit("message", Buffer.from(JSON.stringify(frame)));
  return {
    client: () => client,
    close,
    logGateway,
    logWsControl,
    responses,
    service,
    setClient,
    sendRequest: (method: string, params: unknown) =>
      send({ type: "req", id: "request-1", method, params }),
    sendConnect: () =>
      send({ type: "req", id: "connect-1", method: "connect", params: WORKER_CONNECT }),
  };
}

async function admit(harness: ReturnType<typeof attachHarness>): Promise<void> {
  harness.sendConnect();
  await vi.waitFor(() => expect(harness.responses).toHaveLength(1));
}

describe("dedicated worker websocket protocol", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("admits with a minimal secret-free hello", async () => {
    const harness = attachHarness();
    await admit(harness);

    expect(harness.responses[0]).toMatchObject({ ok: true, payload: { type: "worker-hello-ok" } });
    expect(JSON.stringify([harness.responses, harness.client()])).not.toContain(CREDENTIAL);
    expect(harness.client()).toMatchObject({
      connectionKind: "worker",
      connect: { role: "worker" },
    });
  });

  it("returns a bounded admission rejection", async () => {
    const reason = "invalid-credential" as const;
    const harness = attachHarness({ admissionFailure: reason });
    harness.sendConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, reason));
    expect(harness.responses[0]).toMatchObject({ ok: false, error: { details: { reason } } });
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      `worker admission rejected reason=${reason}`,
    );
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it.each([
    ["node.event", { event: "agent.request", payloadJSON: '{"requestId":"r-1"}' }],
    ["health", {}],
    ["worker.inference", {}],
  ])("rejects legacy method %s", async (method, params) => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest(method, params);

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"));
    expect(harness.logGateway.warn).toHaveBeenCalledWith(
      "worker protocol request rejected reason=method-not-allowed",
    );
  });

  it("accepts heartbeat", async () => {
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await vi.waitFor(() => expect(valid.responses).toHaveLength(2));
    expect(valid.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "ok", ownerEpoch: 1 },
    });
  });

  it("revalidates ownership immediately before admission", async () => {
    const harness = attachHarness({ validationFailure: "credential-replaced" });
    harness.sendConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"));
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it("revalidates ownership on heartbeat", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"));
  });

  it("fences a replaced connection before dispatch", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.client()!.invalidated = true;
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"));
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
  });

  it("rejects authenticated heartbeats while gateway admission is suspended", async () => {
    const harness = attachHarness();
    await admit(harness);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });
      await vi.waitFor(() =>
        expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
      );
      expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
    } finally {
      suspension?.rollback();
    }
  });
});
