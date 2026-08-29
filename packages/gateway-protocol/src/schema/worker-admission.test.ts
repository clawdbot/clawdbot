import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import { FAILOVER_REASONS } from "../failover-reasons.js";
import {
  type WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatRequestFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  WorkerGitHubPublishResponseFrameSchema,
  WorkerLiveEventRequestFrameSchema,
  WorkerLiveEventResponseFrameSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerPortalResponseFrameSchema,
  WorkerSessionsSendResponseFrameSchema,
  WorkerSessionsSpawnResponseFrameSchema,
  WorkerTranscriptCommitRequestFrameSchema,
  WorkerTranscriptCommitResponseFrameSchema,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_RPC_SET_VERSION,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  WORKER_SESSION_TOOL_MAX_TEXT_LENGTH,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  validateWorkerAdmissionHandshake,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
  validateWorkerGitHubPublishParams,
  validateWorkerLiveEventParams,
  validateWorkerPortalParams,
  validateWorkerSessionsSendParams,
  validateWorkerSessionsSpawnParams,
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
const connectRequest = (params: unknown, id = "connect-1") => ({
  type: "req",
  id,
  method: "connect",
  params,
});
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
const transcriptCommit = (overrides: Record<string, unknown> = {}) => ({
  runEpoch: 2,
  seq: 1,
  baseLeafId: null,
  messages: transcriptMessages,
  ...overrides,
});
const commitResponse = (value: Record<string, unknown>) =>
  Value.Check(WorkerTranscriptCommitResponseFrameSchema, {
    type: "res",
    id: "commit-1",
    ...value,
  });
const commitError = (message: string, reason: string) =>
  commitResponse({
    ok: false,
    error: { code: "INVALID_REQUEST", message, details: { reason } },
  });
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
const fallbackStep = (outcome: string, reason?: string) =>
  lifecycle("fallback_step", {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "p/m",
    ...(reason === undefined ? {} : { fallbackStepFromFailureReason: reason }),
    fallbackStepFinalOutcome: outcome,
  });
const fallbackReasonEvents = (reason: string) => [
  lifecycle("fallback", {
    ...models,
    reasonSummary: "x",
    attemptSummaries: ["x"],
    attempts: [{ provider: "p", model: "m", error: "x", reason }],
  }),
  fallbackStep("next_fallback", reason),
];
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
    expect(validateWorkerConnectRequestFrame(connectRequest(connectParams))).toBe(true);
    const missingRunId = structuredClone(connectParams);
    Reflect.deleteProperty(missingRunId.admission, "runId");
    expect(
      validateWorkerConnectRequestFrame(connectRequest(missingRunId, "connect-missing-run")),
    ).toBe(false);
    for (const admission of [
      { ...connectParams.admission, sessionId: null, runId: "run-1" },
      { ...connectParams.admission, sessionId: "session-1", runId: null },
    ]) {
      expect(
        validateWorkerConnectRequestFrame(
          connectRequest({ ...connectParams, admission }, "connect-mismatched-session-run"),
        ),
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

  it("keeps worker session tools closed and payload-bounded", () => {
    const spawn = { toolCallId: "call-spawn", task: "run the child" };
    const send = {
      toolCallId: "call-send",
      sessionKey: "agent:main:dashboard:child",
      message: "report status",
    };
    const publish = { toolCallId: "call-publish", title: "Publish the fix" };
    const portal = { toolCallId: "call-portal", action: "open", port: 3000, path: "/app" };
    expect(validateWorkerSessionsSpawnParams(spawn)).toBe(true);
    expect(validateWorkerSessionsSendParams(send)).toBe(true);
    expect(validateWorkerGitHubPublishParams(publish)).toBe(true);
    expect(validateWorkerPortalParams(portal)).toBe(true);
    expect(validateWorkerSessionsSpawnParams({ ...spawn, unexpected: true })).toBe(false);
    expect(validateWorkerSessionsSendParams({ ...send, message: "" })).toBe(false);
    expect(validateWorkerGitHubPublishParams({ ...publish, token: "secret" })).toBe(false);
    expect(validateWorkerGitHubPublishParams({ ...publish, repository: "openclaw/openclaw" })).toBe(
      false,
    );
    expect(validateWorkerGitHubPublishParams({ ...publish, branch: "main" })).toBe(false);
    expect(validateWorkerGitHubPublishParams({ ...publish, title: "Fix\rInject" })).toBe(false);
    expect(validateWorkerGitHubPublishParams({ ...publish, commitMessage: "Inject" })).toBe(false);
    expect(validateWorkerPortalParams({ ...portal, token: "secret" })).toBe(false);
    expect(validateWorkerPortalParams({ ...portal, action: "unknown" })).toBe(false);
    expect(validateWorkerPortalParams({ ...portal, port: 0 })).toBe(false);
    expect(validateWorkerPortalParams({ ...portal, path: "app" })).toBe(false);
    const escaped = "\0";
    const requestBytes = (method: string, requestParams: object) =>
      Buffer.byteLength(
        JSON.stringify({
          type: "req",
          id: escaped.repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
          method,
          params: requestParams,
        }),
        "utf8",
      );
    const impossibleText = escaped.repeat(10_000);
    const spawnEnvelope = {
      toolCallId: escaped.repeat(256),
      label: escaped.repeat(256),
      agentId: escaped.repeat(256),
      model: escaped.repeat(256),
    };
    const maximalSpawn = {
      ...spawnEnvelope,
      task: escaped.repeat(WORKER_SESSION_TOOL_MAX_TEXT_LENGTH),
      runTimeoutSeconds: 86_400,
    };
    expect(validateWorkerSessionsSpawnParams(maximalSpawn)).toBe(true);
    expect(requestBytes("worker.sessions.spawn", maximalSpawn)).toBeLessThanOrEqual(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    const impossibleSpawn = { ...spawnEnvelope, task: impossibleText };
    expect(requestBytes("worker.sessions.spawn", impossibleSpawn)).toBeGreaterThan(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    expect(validateWorkerSessionsSpawnParams(impossibleSpawn)).toBe(false);

    const sendEnvelope = {
      toolCallId: escaped.repeat(256),
      sessionKey: escaped.repeat(1_024),
      timeoutSeconds: 86_400,
    };
    const maximalSend = {
      ...sendEnvelope,
      message: escaped.repeat(WORKER_SESSION_TOOL_MAX_TEXT_LENGTH),
    };
    expect(validateWorkerSessionsSendParams(maximalSend)).toBe(true);
    expect(requestBytes("worker.sessions.send", maximalSend)).toBeLessThanOrEqual(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    const impossibleSend = { ...sendEnvelope, message: impossibleText };
    expect(requestBytes("worker.sessions.send", impossibleSend)).toBeGreaterThan(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    expect(validateWorkerSessionsSendParams(impossibleSend)).toBe(false);

    const maximalPublish = {
      toolCallId: escaped.repeat(256),
      title: escaped.repeat(256),
      body: escaped.repeat(8 * 1024),
    };
    expect(validateWorkerGitHubPublishParams(maximalPublish)).toBe(true);
    expect(requestBytes("worker.github.publish", maximalPublish)).toBeLessThanOrEqual(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    const maximalPortal = {
      toolCallId: escaped.repeat(256),
      action: "open",
      port: 65_535,
      title: escaped.repeat(256),
      description: escaped.repeat(WORKER_SESSION_TOOL_MAX_TEXT_LENGTH),
      path: `/${escaped.repeat(1_023)}`,
      id: escaped.repeat(256),
    };
    expect(validateWorkerPortalParams(maximalPortal)).toBe(true);
    expect(requestBytes("worker.portal", maximalPortal)).toBeLessThanOrEqual(
      WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    );
    expect(validateWorkerPortalParams({ ...maximalPortal, description: impossibleText })).toBe(
      false,
    );
    expect(
      validateWorkerSessionsSpawnParams({
        ...spawn,
        runTimeoutSeconds: 86_401,
      }),
    ).toBe(false);
    expect(WORKER_PROTOCOL_FEATURES).toContain(WORKER_SESSION_TOOLS_PROTOCOL_FEATURE);
    expect(WORKER_PROTOCOL_FEATURES).toContain(WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE);
    expect(WORKER_PROTOCOL_FEATURES).toContain(WORKER_PORTAL_PROTOCOL_FEATURE);

    const response = {
      type: "res" as const,
      id: "session-tool-1",
      ok: true as const,
      payload: { resultJson: JSON.stringify({ content: [] }) },
    };
    expect(Value.Check(WorkerSessionsSpawnResponseFrameSchema, response)).toBe(true);
    expect(Value.Check(WorkerSessionsSendResponseFrameSchema, response)).toBe(true);
    expect(Value.Check(WorkerGitHubPublishResponseFrameSchema, response)).toBe(true);
    expect(Value.Check(WorkerPortalResponseFrameSchema, response)).toBe(true);
    expect(
      Value.Check(WorkerSessionsSendResponseFrameSchema, {
        ...response,
        payload: { ...response.payload, extra: true },
      }),
    ).toBe(false);
  });

  it("accepts semantic transcript commits and generated-id responses", () => {
    const commitParams = transcriptCommit();
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
      commitResponse({
        ok: true,
        payload: { entryIds: ["entry-1", "entry-2", "entry-3"], newLeafId: "entry-3" },
      }),
    ).toBe(true);
    expect(commitError("worker request rejected", "credential-replaced")).toBe(true);
    expect(commitError("transcript commit rejected", "stale-base-leaf")).toBe(true);
  });

  it("accepts opaque provider replay state on assistant transcript messages", () => {
    const assistantMessage = transcriptMessages[1];
    if (!assistantMessage || assistantMessage.role !== "assistant") {
      throw new Error("expected assistant transcript fixture");
    }
    const providerReplay = {
      v: 1 as const,
      type: "openai-responses-compaction",
      id: "cmp_worker",
      data: "opaque-worker-compaction",
      replayIndex: 1,
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-luna",
      baseUrlHash: "ozhevd1smnk8s",
      sessionHash: "171dzdv17gum5g",
      authProfileHash: "oe8bkr3r8947",
    };
    const candidate = transcriptCommit({
      messages: [{ ...assistantMessage, providerReplay }],
    });

    expect(validateWorkerTranscriptCommitParams(candidate)).toBe(true);
    expect(
      validateWorkerTranscriptCommitParams({
        ...candidate,
        messages: [
          {
            ...assistantMessage,
            providerReplay: { ...providerReplay, privateScratch: "drop" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateWorkerTranscriptCommitParams({
        ...candidate,
        messages: [
          {
            ...assistantMessage,
            providerReplay: {
              ...providerReplay,
              data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES),
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateWorkerTranscriptCommitParams({
        ...candidate,
        messages: [
          {
            ...assistantMessage,
            providerReplay: {
              ...providerReplay,
              data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("advertises only the current execution-context dialect", () => {
    expect(WORKER_PROTOCOL_FEATURES).not.toContain(WORKER_LAUNCH_V2_PROTOCOL_FEATURE);
    expect(WORKER_PROTOCOL_FEATURES).not.toContain("worker-execution-context-v1");
    expect(WORKER_PROTOCOL_FEATURES).toContain("worker-execution-context-v2");
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

  it("keeps both worker fallback reason fields aligned with the canonical vocabulary", () => {
    for (const reason of FAILOVER_REASONS) {
      for (const fallbackEvent of fallbackReasonEvents(reason)) {
        expect(validateLive(params(fallbackEvent))).toBe(true);
      }
    }

    for (const fallbackEvent of fallbackReasonEvents("not-a-reason")) {
      expect(validateLive(params(fallbackEvent))).toBe(false);
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
    transcriptCommit({ messages: [] }),
    transcriptCommit({ seq: 0 }),
    transcriptCommit({ sessionId: "other" }),
    transcriptCommit({ messages: [{ ...transcriptMessages[0], id: "entry-from-worker" }] }),
    transcriptCommit({ messages: [{ ...transcriptMessages[0], parentId: "parent-from-worker" }] }),
    transcriptCommit({
      messages: [{ ...transcriptMessages[0], sessionId: "foreign-session" }],
    }),
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
    const candidate = transcriptCommit({
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
    });

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
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "admission-rejected")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "credential-replaced")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "placement-mismatch")).toBe(true);
    expect(Value.Check(WorkerProtocolCloseReasonSchema, "not-a-worker-reason")).toBe(false);
  });
});
