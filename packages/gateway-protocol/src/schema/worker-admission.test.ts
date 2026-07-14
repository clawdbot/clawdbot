import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import {
  type WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerLiveEventRequestFrameSchema,
  WorkerLiveEventResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerTranscriptCommitRequestFrameSchema,
  WorkerTranscriptCommitResponseFrameSchema,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  validateWorkerAdmissionHandshake,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
  validateWorkerLiveEventParams,
  validateWorkerTranscriptCommitParams,
} from "../index.js";
import {
  WORKER_INFERENCE_MAX_OUTPUT_TOKENS,
  validateWorkerInferenceStartParams,
} from "./worker-inference.js";

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
    runId: null,
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
const liveBase = { runEpoch: 2, lastAckedSeq: 0, seq: 1, runId: "r" };
const models = {
  selectedProvider: "p",
  selectedModel: "m",
  activeProvider: "q",
  activeModel: "n",
};
const event = (kind: string, payload: Record<string, unknown>) => ({ kind, payload });
const params = (liveEvent: unknown, overrides: Record<string, unknown> = {}) => ({
  ...liveBase,
  event: liveEvent,
  ...overrides,
});
const tool = (phase: string, payload: Record<string, unknown>) =>
  event("tool", { phase, name: "t", toolCallId: "c", ...payload });

const inferenceIdentity = {
  runEpoch: 2,
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
};
const inferenceStart = {
  ...inferenceIdentity,
  modelRef: { provider: "fixture-provider", model: "fixture-model" },
  context: {
    messages: [{ role: "user" as const, content: "Run the probe.", timestamp: 1 }],
  },
  options: { temperature: 0.5, maxTokens: 1_024, reasoning: "medium" as const },
};
const approval = (phase: string, status: string) =>
  event("approval", { phase, kind: "exec", status, title: "x" });
const lifecycle = (phase: string, payload: Record<string, unknown> = {}) =>
  event("lifecycle", { phase, ...payload });
const fallbackStep = (outcome: string) =>
  lifecycle("fallback_step", {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "p/m",
    fallbackStepFinalOutcome: outcome,
  });
const assistant = event("assistant", { text: "x", delta: "x" });
const validateLive = validateWorkerLiveEventParams;
const liveError = (details: Record<string, unknown>) => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message: "x", details },
});
const liveRequest = (value: unknown) =>
  Value.Check(WorkerLiveEventRequestFrameSchema, {
    type: "req",
    id: "l",
    method: "worker.live-event",
    params: value,
  });
const liveResponse = (value: Record<string, unknown>) =>
  Value.Check(WorkerLiveEventResponseFrameSchema, { type: "res", id: "l", ...value });

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
    const missingRunId = structuredClone(connectParams);
    Reflect.deleteProperty(missingRunId.admission, "runId");
    expect(
      validateWorkerConnectRequestFrame({
        type: "req",
        id: "connect-missing-run",
        method: "connect",
        params: missingRunId,
      }),
    ).toBe(false);
    for (const admission of [
      { ...connectParams.admission, sessionId: null, runId: "run-1" },
      { ...connectParams.admission, sessionId: "session-1", runId: null },
    ]) {
      expect(
        validateWorkerConnectRequestFrame({
          type: "req",
          id: "connect-mismatched-session-run",
          method: "connect",
          params: { ...connectParams, admission },
        }),
      ).toBe(false);
    }
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
    const commitParams = {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: transcriptMessages,
    };
    expect(validateWorkerTranscriptCommitParams(commitParams)).toBe(true);
    expect(
      Value.Check(WorkerTranscriptCommitRequestFrameSchema, {
        type: "req",
        id: "commit-1",
        method: "worker.transcript.commit",
        params: commitParams,
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

  it("validates the additive live-event protocol", () => {
    expect(WORKER_RPC_SET_VERSION).toBe(1);
    expect(WORKER_PROTOCOL_FEATURES).toContain("worker-live-event-v1");
    for (const validEvent of [
      assistant,
      event("thinking", { text: "x", delta: "x" }),
      tool("start", { args: {} }),
      tool("update", { partialResult: { output: "x" } }),
      tool("result", { result: { output: "x" }, isError: false }),
      approval("requested", "pending"),
      approval("resolved", "approved"),
      lifecycle("start", { startedAt: 1 }),
      lifecycle("fallback", {
        ...models,
        reasonSummary: "x",
        attemptSummaries: ["x"],
        attempts: [{ provider: "p", model: "m", error: "x", authMode: "key" }],
      }),
      lifecycle("fallback_cleared", models),
      fallbackStep("next_fallback"),
      lifecycle("finishing", { endedAt: 2, error: "x" }),
      lifecycle("end", { endedAt: 3 }),
      lifecycle("error", { endedAt: 4, error: "x" }),
    ]) {
      expect(validateLive(params(validEvent))).toBe(true);
    }
    expect(liveRequest(params(assistant))).toBe(true);
    expect(liveResponse({ ok: true, payload: { ackedSeq: 3 } })).toBe(true);
    for (const details of [
      { reason: "epoch-mismatch" },
      { reason: "session-not-attached" },
      { reason: "invalid-event" },
      { reason: "capacity-exceeded" },
      { reason: "resync-required", ackedSeq: 3, expectedSeq: 4 },
    ]) {
      expect(liveResponse(liveError(details))).toBe(true);
    }
    expect(liveResponse(liveError({ reason: "later" }))).toBe(false);
    expect(liveResponse({ ok: true, payload: { ackedSeq: -1 } })).toBe(false);
    for (const [field, value] of [
      ["runEpoch", -1],
      ["lastAckedSeq", -1],
      ["lastAckedSeq", Number.MAX_SAFE_INTEGER + 1],
      ["seq", 0],
      ["seq", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(validateLive(params(assistant, { [field]: value }))).toBe(false);
    }
    for (const invalid of [
      params(event("unknown", {})),
      params(tool("start", { args: {}, partialResult: {} })),
      params(approval("requested", "approved")),
      params(lifecycle("end", { endedAt: 4, error: "stopped" })),
      params(fallbackStep("retrying")),
      params({ ...assistant, seq: 8 }),
      params(assistant, { sessionKey: "x" }),
      {
        runEpoch: liveBase.runEpoch,
        seq: liveBase.seq,
        runId: liveBase.runId,
        event: assistant,
      },
    ]) {
      expect(validateLive(invalid)).toBe(false);
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const [value, keyword] of [
      [Number.POSITIVE_INFINITY, "finite"],
      [cyclic, "acyclic"],
    ] as const) {
      expect(validateLive(params(tool("update", { partialResult: value })))).toBe(false);
      expect(validateLive.errors?.[0]).toMatchObject({ keyword });
    }
  });

  it("accepts only a model reference and constrained inference options", () => {
    expect(
      validateWorkerInferenceStartParams({
        ...inferenceStart,
        options: { ...inferenceStart.options, reasoning: "adaptive" },
      }),
    ).toBe(true);
    const route = { baseUrl: "https://invalid.example", headers: { "x-route": "override" } };
    for (const candidate of [
      { ...inferenceStart, model: { provider: "p", id: "m", ...route } },
      { ...inferenceStart, modelRef: { ...inferenceStart.modelRef, ...route } },
      { ...inferenceStart, options: { ...inferenceStart.options, ...route } },
      { ...inferenceStart, options: { ...inferenceStart.options, arbitrary: true } },
      { ...inferenceStart, options: { maxTokens: WORKER_INFERENCE_MAX_OUTPUT_TOKENS + 1 } },
    ]) {
      expect(validateWorkerInferenceStartParams(candidate)).toBe(false);
    }
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
    const transcriptAssistant = transcriptMessages[1];
    if (!transcriptAssistant || transcriptAssistant.role !== "assistant") {
      throw new Error("expected assistant transcript fixture");
    }
    const candidate = {
      runEpoch: 2,
      seq: 1,
      baseLeafId: null,
      messages: [
        {
          ...transcriptAssistant,
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
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "placement-mismatch")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "not-a-worker-reason")).toBe(false);
  });
});
