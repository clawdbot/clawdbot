import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import {
  type WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WORKER_RPC_SET_VERSION,
  validateWorkerAdmissionHandshake,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
} from "../index.js";

const bundleHash = "a".repeat(64);
const handshake: WorkerAdmissionHandshake = {
  bundleHash,
  openclawVersion: "2026.7.11",
  protocolFeatures: [],
};
const credential = ["worker", "credential", "fixture"].join("-");
const connectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "2026.7.11",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission: {
    environmentId: "worker-1",
    credential,
    sessionId: null,
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake,
  },
};
const workerHello = {
  type: "worker-hello-ok" as const,
  environmentId: "worker-1",
  sessionId: null,
  ownerEpoch: 1,
  rpcSetVersion: WORKER_RPC_SET_VERSION,
  protocolFeatures: ["worker-heartbeat-v1"],
  credentialExpiresAtMs: 10_000,
  policy: { heartbeatIntervalMs: 15_000, maxPayload: 1_024 },
};

describe("worker admission handshake schema", () => {
  it("accepts the bootstrap receipt and future unique feature names", () => {
    expect(validateWorkerAdmissionHandshake(handshake)).toBe(true);
    expect(
      validateWorkerAdmissionHandshake({
        ...handshake,
        protocolFeatures: ["run-v1", "resume-v1"],
      }),
    ).toBe(true);
  });

  it.each([
    { ...handshake, bundleHash: "short" },
    { ...handshake, bundleHash: "A".repeat(64) },
    { ...handshake, openclawVersion: "" },
    { ...handshake, protocolFeatures: [""] },
    { ...handshake, protocolFeatures: ["run-v1", "run-v1"] },
    { ...handshake, unexpected: true },
  ])("rejects malformed admission identity %#", (candidate) => {
    expect(validateWorkerAdmissionHandshake(candidate)).toBe(false);
  });
});

describe("worker protocol schemas", () => {
  it("accepts a dedicated connect and explicit unattached session", () => {
    expect(
      validateWorkerConnectRequestFrame({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: connectParams,
      }),
    ).toBe(true);
    expect(
      Value.Check(WorkerAdmissionResponseFrameSchema, {
        type: "res",
        id: "connect-1",
        ok: true,
        payload: workerHello,
      }),
    ).toBe(true);
  });

  it("validates heartbeat status frames", () => {
    expect(validateWorkerHeartbeatParams({ sentAtMs: 1, status: "ready" })).toBe(true);
    expect(validateWorkerHeartbeatParams({ sentAtMs: 1, status: "unknown" })).toBe(false);
    const request = {
      type: "req" as const,
      id: "heartbeat-1",
      method: "worker.heartbeat" as const,
      params: { sentAtMs: 1, status: "busy" as const },
    };
    const response = {
      type: "res" as const,
      id: request.id,
      ok: true as const,
      payload: { receivedAtMs: 2, status: "ok" as const, ownerEpoch: 1 },
    };
    expect(Value.Check(WorkerHeartbeatRequestFrameSchema, request)).toBe(true);
    expect(Value.Check(WorkerHeartbeatResponseFrameSchema, response)).toBe(true);
  });

  it("keeps worker close reasons closed", () => {
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "credential-replaced")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "not-a-worker-reason")).toBe(false);
  });
});
