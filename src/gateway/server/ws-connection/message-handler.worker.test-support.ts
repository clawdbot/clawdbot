import { afterEach, expect, vi } from "vitest";
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
  WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE,
  WORKER_COMPUTER_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  type WorkerSessionToolResult,
  type WorkerTranscriptCommitErrorReason,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalFrame,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import { createGatewayWsTestSocket } from "../ws-connection.test-helpers.js";
import type { GatewayWsClient } from "../ws-types.js";
import { attachWorkerWsMessageHandler, type WorkerConnectionService } from "./worker-connection.js";

export const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
export const HANDSHAKE = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.11",
  protocolFeatures: [
    "worker-heartbeat-v1",
    WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
    WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
    WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
    WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE,
    WORKER_PORTAL_PROTOCOL_FEATURE,
    WORKER_INFERENCE_PROTOCOL_FEATURE,
    WORKER_COMPUTER_PROTOCOL_FEATURE,
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
export const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "worker-1",
  credentialHash: "h".repeat(43),
  bundleHash: HANDSHAKE.bundleHash,
  sessionId: null,
  runId: null,
  turnClaim: null,
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: [...HANDSHAKE.protocolFeatures],
  credentialExpiresAtMs: Date.now() + 60_000,
};
export const TRANSCRIPT_COMMIT = {
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
export const LIVE_EVENT = {
  runEpoch: 1,
  lastAckedSeq: 0,
  seq: 1,
  runId: "r",
  event: { kind: "assistant" as const, payload: { text: "x", delta: "x" } },
};
export const ATTACHED_IDENTITY: WorkerConnectionIdentity = {
  ...IDENTITY,
  sessionId: "session-1",
  runId: "run-1",
  turnClaim: {
    sessionId: "session-1",
    claimId: "claim-1",
    runId: "run-1",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
  },
};
export const INFERENCE_IDS = {
  runEpoch: 1,
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
} as const;
export const INFERENCE_START: WorkerInferenceStartParams = {
  ...INFERENCE_IDS,
  modelRef: { provider: "test-provider", model: "sonnet-4.6" },
  context: {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  },
  options: { maxTokens: 128, temperature: 0.2 },
};
export const INFERENCE_EVENT: WorkerInferenceEventFrame = {
  type: "event",
  event: "worker.inference.event",
  payload: {
    ...INFERENCE_IDS,
    seq: 1,
    event: { type: "text_delta", contentIndex: 0, delta: "x" },
  },
};
const cleanups: Array<() => void> = [];

export function waitForWorkerProtocol(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type InferenceSink = {
  connectionId: string;
  send(frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame): void;
};

function createLogger() {
  return { warn: vi.fn() };
}

export function createRateLimiter(overrides: Partial<AuthRateLimiter> = {}): AuthRateLimiter {
  return {
    check: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
    recordFailure: vi.fn(),
    recordFailureAndDelay: vi.fn(async () => {}),
    reset: vi.fn(),
    size: vi.fn(() => 0),
    prune: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

export function attachHarness(
  options: {
    admissionFailure?: WorkerAdmissionFailureReason;
    commitFailure?: WorkerTranscriptCommitErrorReason;
    closeDuringHello?: boolean;
    identity?: WorkerConnectionIdentity;
    liveFailure?: WorkerLiveEventErrorDetails;
    omitPublicAdmission?: boolean;
    rateLimiter?: AuthRateLimiter;
    onInferenceLaunch?: (sink: InferenceSink) => void;
    onSessionTool?: (signal: AbortSignal | undefined) => Promise<WorkerSessionToolResult>;
    startupPending?: () => boolean;
    validationFailure?: ReturnType<WorkerConnectionService["validateWorkerConnection"]>;
  } = {},
) {
  const socket = createGatewayWsTestSocket();
  const responses: unknown[] = [];
  let closed = false;
  const close = vi.fn(() => {
    closed = true;
    cleanup();
  });
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
    executeSessionTool: vi.fn(async (_identity, _toolName, _request, signal) => ({
      ok: true as const,
      result: options.onSessionTool
        ? await options.onSessionTool(signal)
        : { resultJson: JSON.stringify({ content: [] }) },
    })),
    executeComputer: vi.fn<NonNullable<WorkerConnectionService["executeComputer"]>>(async () => ({
      ok: true,
      result: { resultJson: JSON.stringify({ format: "png", base64: "a".repeat(128 * 1024) }) },
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
  const setCloseCause = vi.fn();
  const setLastFrameMeta = vi.fn();
  const advanceHandshakePhase = vi.fn();
  const cleanup = attachWorkerWsMessageHandler({
    socket: socket as unknown as WebSocket,
    connId: "worker-connection",
    service,
    isStartupPending: options.startupPending,
    publicAdmission: options.omitPublicAdmission
      ? undefined
      : { clientIp: "203.0.113.10", rateLimiter: options.rateLimiter },
    send: (frame) => {
      responses.push(frame);
      if (options.closeDuringHello) {
        close();
      }
    },
    close,
    isClosed: () => closed,
    clearHandshakeTimer: vi.fn(),
    getClient: () => client,
    setClient,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase,
    setCloseCause,
    setLastFrameMeta,
    logGateway,
    logWsControl,
  });
  cleanups.push(cleanup);
  const send = (frame: unknown) => socket.emit("message", Buffer.from(JSON.stringify(frame)));
  return {
    client: () => client,
    cleanup,
    close,
    advanceHandshakePhase,
    logGateway,
    logWsControl,
    responses,
    service,
    setClient,
    setCloseCause,
    setLastFrameMeta,
    sendRequest: (method: string, params: unknown, id = "request-1") =>
      send({ type: "req", id, method, params }),
    sendConnect: () =>
      send({ type: "req", id: "connect-1", method: "connect", params: WORKER_CONNECT }),
  };
}

export async function admit(harness: ReturnType<typeof attachHarness>): Promise<void> {
  harness.sendConnect();
  await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(1));
}

export function setupWorkerProtocolTestState() {
  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });
}
