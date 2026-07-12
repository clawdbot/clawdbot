import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import {
  type WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptCommitRequestFrameSchema,
  WorkerTranscriptCommitResponseFrameSchema,
  WORKER_RPC_SET_VERSION,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  validateWorkerAdmissionHandshake,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
  validateWorkerTranscriptCommitParams,
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
const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const transcriptMessages = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "run the probe" }],
    timestamp: 1,
  },
  {
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "call-1",
        name: "probe",
        arguments: { value: 1 },
      },
    ],
    api: "responses",
    provider: "fixture",
    model: "fixture-model",
    usage,
    stopReason: "toolUse" as const,
    timestamp: 2,
  },
  {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "probe",
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: 3,
  },
];

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

  it("accepts semantic transcript commits and generated-id responses", () => {
    const params = {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: transcriptMessages,
    };
    expect(validateWorkerTranscriptCommitParams(params)).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitRequestFrameSchema, {
        type: "req",
        id: "commit-1",
        method: "worker.transcript.commit",
        params,
      }),
    ).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitResponseFrameSchema, {
        type: "res",
        id: "commit-1",
        ok: true,
        payload: { entryIds: ["entry-1", "entry-2", "entry-3"], newLeafId: "entry-3" },
      }),
    ).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitResponseFrameSchema, {
        type: "res",
        id: "commit-1",
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker request rejected",
          details: { reason: "credential-replaced" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitResponseFrameSchema, {
        type: "res",
        id: "commit-1",
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "transcript commit rejected",
          details: { reason: "stale-base-leaf" },
        },
      }),
    ).toBe(true);
  });

  it.each([
    { runEpoch: 2, seq: 1, baseLeafId: null, messages: [] },
    { runEpoch: 2, seq: 0, baseLeafId: null, messages: transcriptMessages },
    { runEpoch: 2, seq: 1, baseLeafId: null, messages: transcriptMessages, sessionId: "other" },
    {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: [{ ...transcriptMessages[0], id: "entry-from-worker" }],
    },
    {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: [{ ...transcriptMessages[0], parentId: "parent-from-worker" }],
    },
    {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: [{ ...transcriptMessages[0], sessionId: "foreign-session" }],
    },
  ])("rejects raw transcript identity or invalid batch fields %#", (candidate) => {
    expect(validateWorkerTranscriptCommitParams(candidate)).toBe(false);
  });

  it("rejects deeply nested worker JSON before schema compilation", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth <= WORKER_TRANSCRIPT_MAX_JSON_DEPTH; depth += 1) {
      nested = { nested };
    }
    const assistant = transcriptMessages[1];
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("expected assistant transcript fixture");
    }
    const candidate = {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: [
        {
          ...assistant,
          content: [
            {
              type: "toolCall" as const,
              id: "call-deep",
              name: "probe",
              arguments: { nested },
            },
          ],
        },
      ],
    };

    expect(validateWorkerTranscriptCommitParams(candidate)).toBe(false);
    expect(validateWorkerTranscriptCommitParams.errors?.[0]).toMatchObject({
      keyword: "maxDepth",
      params: { limit: WORKER_TRANSCRIPT_MAX_JSON_DEPTH },
    });
  });

  it("rejects non-finite numbers parsed from worker JSON", () => {
    const candidate = JSON.parse(`{
      "runEpoch": 2,
      "seq": 1,
      "baseLeafId": null,
      "messages": [{
        "role": "toolResult",
        "toolCallId": "call-non-finite",
        "toolName": "probe",
        "content": [],
        "details": { "value": 1e400 },
        "isError": false,
        "timestamp": 1
      }]
    }`) as unknown;

    expect(validateWorkerTranscriptCommitParams(candidate)).toBe(false);
    expect(validateWorkerTranscriptCommitParams.errors?.[0]).toMatchObject({
      keyword: "finite",
    });
  });

  it("keeps worker close reasons closed", () => {
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "credential-replaced")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "not-a-worker-reason")).toBe(false);
  });
});
