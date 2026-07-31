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
  type WorkerLiveEventErrorDetails,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  type WorkerTranscriptCommitErrorReason,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalFrame,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
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
  protocolFeatures: [
    "worker-heartbeat-v1",
    WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
    WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
    WORKER_INFERENCE_PROTOCOL_FEATURE,
  ],
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
    runId: null,
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
  runId: null,
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: [...HANDSHAKE.protocolFeatures],
  credentialExpiresAtMs: Date.now() + 60_000,
};
const TRANSCRIPT_COMMIT = {
  runEpoch: 1,
  seq: 1,
  baseLeafId: null,
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
      timestamp: 1,
    },
  ],
};
const LIVE_EVENT = {
  runEpoch: 1,
  lastAckedSeq: 0,
  seq: 1,
  runId: "r",
  event: { kind: "assistant" as const, payload: { text: "x", delta: "x" } },
};
const ATTACHED_IDENTITY: WorkerConnectionIdentity = {
  ...IDENTITY,
  sessionId: "session-1",
  runId: "run-1",
};
const INFERENCE_IDS = {
  runEpoch: 1,
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
} as const;
const INFERENCE_START: WorkerInferenceStartParams = {
  ...INFERENCE_IDS,
  modelRef: { provider: "test-provider", model: "sonnet-4.6" },
  context: {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  },
  options: { maxTokens: 128, temperature: 0.2 },
};
const INFERENCE_EVENT: WorkerInferenceEventFrame = {
  type: "event",
  event: "worker.inference.event",
  payload: {
    ...INFERENCE_IDS,
    seq: 1,
    event: { type: "text_delta", contentIndex: 0, delta: "x" },
  },
};
const cleanups: Array<() => void> = [];

function waitForWorkerProtocol(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type InferenceSink = {
  connectionId: string;
  send(frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame): void;
};

function createLogger() {
  return { warn: vi.fn() };
}

function attachHarness(
  options: {
    admissionFailure?: WorkerAdmissionFailureReason;
    commitFailure?: WorkerTranscriptCommitErrorReason;
    identity?: WorkerConnectionIdentity;
    liveFailure?: WorkerLiveEventErrorDetails;
    onInferenceLaunch?: (sink: InferenceSink) => void;
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
        : { ok: true as const, identity: options.identity ?? IDENTITY },
    ),
    commitTranscript: vi.fn(async () =>
      options.commitFailure
        ? { ok: false as const, reason: options.commitFailure }
        : {
            ok: true as const,
            result: { entryIds: ["entry-1"], newLeafId: "entry-1" },
          },
    ),
    pushLiveEvent: vi.fn(async () =>
      options.liveFailure
        ? { ok: false as const, details: options.liveFailure }
        : { ok: true as const, result: { ackedSeq: LIVE_EVENT.seq } },
    ),
    startInference: vi.fn(
      (
        _identity: WorkerConnectionIdentity,
        _request: WorkerInferenceStartParams,
        sink: InferenceSink,
      ) => {
        return {
          ok: true as const,
          result: { status: "accepted" as const },
          launch: () => options.onInferenceLaunch?.(sink),
        };
      },
    ),
    cancelInference: vi.fn(() => ({
      ok: true as const,
      result: { status: "cancelled" as const },
    })),
    validateWorkerConnection: vi.fn(() => options.validationFailure ?? null),
  };
  let client: GatewayWsClient | null = null;
  const setClient = vi.fn((next: GatewayWsClient) => {
    client = next;
    return true;
  });
  const logGateway = createLogger();
  const logWsControl = createLogger();
  const setLastFrameMeta = vi.fn();
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
    setLastFrameMeta,
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
    setLastFrameMeta,
    sendRequest: (method: string, params: unknown, id = "request-1") =>
      send({ type: "req", id, method, params }),
    sendConnect: () =>
      send({ type: "req", id: "connect-1", method: "connect", params: WORKER_CONNECT }),
  };
}

async function admit(harness: ReturnType<typeof attachHarness>): Promise<void> {
  harness.sendConnect();
  await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(1));
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

    await waitForWorkerProtocol(() => expect(harness.close).toHaveBeenCalledWith(1008, reason));
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

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.logGateway.warn).toHaveBeenCalledWith(
      "worker protocol request rejected reason=method-not-allowed",
    );
  });

  it("accepts heartbeat", async () => {
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await waitForWorkerProtocol(() => expect(valid.responses).toHaveLength(2));
    expect(valid.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "ok", ownerEpoch: 1 },
    });
  });

  it("gates inference independently", async () => {
    const unsupported = attachHarness({
      identity: {
        ...ATTACHED_IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_INFERENCE_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.inference.start", INFERENCE_START);
    await waitForWorkerProtocol(() =>
      expect(unsupported.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(unsupported.service.startInference).not.toHaveBeenCalled();
  });

  it("acknowledges inference before forwarding synchronous stream frames", async () => {
    const harness = attachHarness({
      identity: ATTACHED_IDENTITY,
      onInferenceLaunch: (sink) => sink.send(INFERENCE_EVENT),
    });
    await admit(harness);
    harness.sendRequest("worker.inference.start", INFERENCE_START);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(3));
    expect(harness.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "accepted" },
    });
    expect(harness.responses[2]).toEqual(INFERENCE_EVENT);
    expect(harness.service.startInference).toHaveBeenCalledOnce();

    harness.sendRequest("worker.inference.cancel", INFERENCE_IDS, "cancel-1");
    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(4));
    expect(harness.responses[3]).toMatchObject({
      ok: true,
      payload: { status: "cancelled" },
    });
    expect(harness.service.cancelInference).toHaveBeenCalledWith(ATTACHED_IDENTITY, INFERENCE_IDS);
  });

  it("dispatches semantic transcript commits on the closed worker allowlist", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: true,
      payload: { entryIds: ["entry-1"], newLeafId: "entry-1" },
    });
    expect(harness.service.commitTranscript).toHaveBeenCalledWith(IDENTITY, TRANSCRIPT_COMMIT);
    expect(harness.setLastFrameMeta).toHaveBeenLastCalledWith({
      type: "req",
      method: "worker.transcript.commit",
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("gates live-event features, schema, and closed errors", async () => {
    const unsupported = attachHarness({
      identity: {
        ...IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.live-event", LIVE_EVENT);
    await waitForWorkerProtocol(() => expect(unsupported.close).toHaveBeenCalled());
    expect(unsupported.service.pushLiveEvent).not.toHaveBeenCalled();

    const resync = attachHarness({
      liveFailure: { reason: "resync-required", ackedSeq: 2, expectedSeq: 3 },
    });
    await admit(resync);
    resync.sendRequest("worker.live-event", { ...LIVE_EVENT, seq: 7 });
    await waitForWorkerProtocol(() =>
      expect(resync.responses[1]).toMatchObject({
        error: { details: { reason: "resync-required" } },
      }),
    );
    expect(resync.service.pushLiveEvent).toHaveBeenCalledOnce();

    const invalid = attachHarness();
    await admit(invalid);
    invalid.sendRequest("worker.live-event", {
      ...LIVE_EVENT,
      event: { kind: "assistant", payload: { delta: "x" } },
    });
    await waitForWorkerProtocol(() =>
      expect(invalid.responses[1]).toMatchObject({
        error: { details: { reason: "invalid-event" } },
      }),
    );
    expect(invalid.service.pushLiveEvent).not.toHaveBeenCalled();
  });

  it("rejects transcript commits when the admitted worker lacks the feature", async () => {
    const harness = attachHarness({
      identity: { ...IDENTITY, protocolFeatures: ["worker-heartbeat-v1"] },
    });
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
  });

  it("returns closed transcript errors without closing the worker connection", async () => {
    const harness = attachHarness({ commitFailure: "stale-base-leaf" });
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "stale-base-leaf" } },
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("rejects structurally invalid transcript batches before application", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-batch" } },
    });
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("closes a replaced worker before parsing a malformed transcript batch", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "credential-replaced" } },
    });
    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
  });

  it("revalidates ownership immediately before admission", async () => {
    const harness = attachHarness({ validationFailure: "credential-replaced" });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it("revalidates ownership on heartbeat", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
  });

  it("fences a replaced connection before dispatch", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.client()!.invalidated = true;
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
  });

  it("rejects authenticated heartbeats while gateway admission is suspended", async () => {
    const harness = attachHarness();
    await admit(harness);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });
      await waitForWorkerProtocol(() =>
        expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
      );
      expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
    } finally {
      suspension?.rollback();
    }
  });
});
