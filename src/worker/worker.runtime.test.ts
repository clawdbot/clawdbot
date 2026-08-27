import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  validateWorkerGitHubPublishParams,
  validateWorkerSessionsSendParams,
  validateWorkerSessionsSpawnParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerHeartbeatRequestFrame,
  WorkerHeartbeatRequestFrameSchema,
  type WorkerLiveEventParams,
  type WorkerLiveEventRequestFrame,
  WorkerLiveEventRequestFrameSchema,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  type WorkerGitHubPublishParams,
  type WorkerSessionsSendParams,
  type WorkerSessionsSpawnParams,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptCommitRequestFrameSchema,
  type WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerInferenceCancelRequestFrame,
  WorkerInferenceCancelRequestFrameSchema,
  type WorkerInferenceEventFrame,
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartRequestFrame,
  WorkerInferenceStartRequestFrameSchema,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import { saveExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "./transcript-message.js";
import {
  WorkerAdmissionDeadlineExceededError,
  WorkerConnectionStoppedError,
} from "./worker-connection-contract.js";
import { createWorkerConnection, type WorkerConnectionState } from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const browserRuntimeMocks = vi.hoisted(() => ({
  createWorkerBrowserToolRuntime: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("./browser-runtime.js", () => {
  browserRuntimeMocks.createWorkerBrowserToolRuntime.mockImplementation(async () => ({
    tool: {
      name: "browser",
      label: "Browser",
      description: "Control the attached worker browser.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    dispose: browserRuntimeMocks.dispose,
  }));
  return { createWorkerBrowserToolRuntime: browserRuntimeMocks.createWorkerBrowserToolRuntime };
});

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const SESSION_ID = "worker-session";
const RUN_ID = "worker-run";
const OWNER_EPOCH = 4;
const MODEL_REF = { provider: "openai", model: "gpt-5.6-luna" } as const;
const WORKER_LOOP_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  data: "opaque-worker-loop-replay",
  provider: "openai",
  api: "openai-responses",
  model: MODEL_REF.model,
  baseUrlHash: "ozhevd1smnk8s",
};
const BUNDLE_HASH = Array.from({ length: 64 }, () => "a").join("");
const CREDENTIAL = ["worker", "fixture", "admission"].join("-");
const WORKER_INFERENCE_START_TIMEOUT_MS = 90_000;

type InferencePlan =
  | "text"
  | "tool"
  | "safe-tool"
  | "background-tool"
  | "session-tool"
  | "hold"
  | "fence"
  | "error"
  | "cancelled"
  | "length"
  | "burst-text"
  | "oversized-text"
  | "oversized-error"
  | "empty-terminal";
type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

type FakeGatewayOptions = {
  admissionFailure?: "gateway-unavailable" | "invalid-credential" | "owner-epoch-mismatch";
  execApprovals?: ExecApprovalsFile;
  inferencePlans?: InferencePlan[];
  outageOnInferenceCancel?: boolean;
  ignoreFirstAdmission?: boolean;
  ignoreHeartbeat?: boolean;
  silenceFirstTranscript?: boolean;
  silenceFirstLiveEvent?: boolean;
  silenceFirstInference?: boolean;
  silenceSessionToolResponses?: number;
  transcriptFailureAtRequest?: number;
  liveResyncAckedSeq?: number;
  liveResyncResponses?: number;
  liveFailure?: "capacity-exceeded";
  heartbeatFailure?: "credential-expired";
  heartbeatIntervalMs?: number;
};

function assistantMessage(
  content: WorkerDoneMessage["content"],
  stopReason: WorkerDoneMessage["stopReason"],
): WorkerDoneMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: MODEL_REF.provider,
    model: MODEL_REF.model,
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

class FakeWorkerGateway {
  private readonly httpServer: Server;
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private rootDir: string | undefined;
  private inferencePlanIndex = 0;
  private droppedTranscript = false;
  private droppedLiveEvent = false;
  private droppedInference = false;
  private sentLiveResync = 0;
  private unavailable = false;
  private ignoredAdmission = false;
  private readonly inferenceStarted = createDeferred();

  socketPath = "";
  connectionCount = 0;
  readonly methods: string[] = [];
  readonly transcriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly acceptedTranscriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly liveEventRequests: WorkerLiveEventParams[] = [];
  readonly inferenceRequests: WorkerInferenceStartParams[] = [];
  readonly sessionSpawnRequests: WorkerSessionsSpawnParams[] = [];
  readonly sessionSendRequests: WorkerSessionsSendParams[] = [];
  readonly githubPublishRequests: WorkerGitHubPublishParams[] = [];
  readonly applicationOrder: string[] = [];

  waitForInferenceStart(): Promise<void> {
    return withTestTimeout(
      this.inferenceStarted.promise,
      WORKER_INFERENCE_START_TIMEOUT_MS,
      "worker inference start did not reach the fake Gateway",
    );
  }

  constructor(private readonly options: FakeGatewayOptions = {}) {
    this.httpServer = createServer();
    this.webSocketServer = new WebSocketServer({ server: this.httpServer });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    this.rootDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-gateway-"));
    this.socketPath = path.join(this.rootDir, "gateway.sock");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.socketPath);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
    if (this.rootDir) {
      await rm(this.rootDir, { recursive: true, force: true });
    }
  }

  private accept(socket: WebSocket): void {
    this.connectionCount += 1;
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("message", (data: RawData) => this.handleMessage(socket, data));
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    if (Value.Check(WorkerConnectRequestFrameSchema, parsed)) {
      this.handleConnect(socket, parsed as WorkerConnectRequestFrame);
      return;
    }
    if (Value.Check(WorkerHeartbeatRequestFrameSchema, parsed)) {
      this.handleHeartbeat(socket, parsed as WorkerHeartbeatRequestFrame);
      return;
    }
    if (Value.Check(WorkerTranscriptCommitRequestFrameSchema, parsed)) {
      this.handleTranscript(socket, parsed as WorkerTranscriptCommitRequestFrame);
      return;
    }
    if (Value.Check(WorkerLiveEventRequestFrameSchema, parsed)) {
      this.handleLiveEvent(socket, parsed as WorkerLiveEventRequestFrame);
      return;
    }
    if (Value.Check(WorkerInferenceStartRequestFrameSchema, parsed)) {
      this.handleInference(socket, parsed as WorkerInferenceStartRequestFrame);
      return;
    }
    if (Value.Check(WorkerInferenceCancelRequestFrameSchema, parsed)) {
      this.handleInferenceCancel(socket, parsed as WorkerInferenceCancelRequestFrame);
      return;
    }
    if (isRecord(parsed) && parsed.type === "req" && typeof parsed.id === "string") {
      const sessionToolMethod =
        parsed.method === "worker.sessions.spawn" &&
        validateWorkerSessionsSpawnParams(parsed.params)
          ? parsed.method
          : parsed.method === "worker.sessions.send" &&
              validateWorkerSessionsSendParams(parsed.params)
            ? parsed.method
            : parsed.method === "worker.github.publish" &&
                validateWorkerGitHubPublishParams(parsed.params)
              ? parsed.method
              : undefined;
      if (sessionToolMethod) {
        this.handleSessionTool(socket, {
          id: parsed.id,
          method: sessionToolMethod,
          params: parsed.params as
            | WorkerSessionsSpawnParams
            | WorkerSessionsSendParams
            | WorkerGitHubPublishParams,
        });
        return;
      }
    }
    const unsupported: unknown = parsed;
    if (isRecord(unsupported) && typeof unsupported.method === "string") {
      this.methods.push(unsupported.method);
    }
    socket.close(1008, "invalid-frame");
  }

  private handleConnect(socket: WebSocket, frame: WorkerConnectRequestFrame): void {
    this.methods.push(frame.method);
    if (this.unavailable) {
      socket.terminate();
      return;
    }
    if (this.options.ignoreFirstAdmission && !this.ignoredAdmission) {
      this.ignoredAdmission = true;
      return;
    }
    if (this.options.admissionFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker fixture rejected",
          details: { reason: this.options.admissionFailure },
          retryable: true,
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        type: "worker-hello-ok",
        environmentId: frame.params.admission.environmentId,
        sessionId: frame.params.admission.sessionId,
        ownerEpoch: frame.params.admission.ownerEpoch,
        rpcSetVersion: frame.params.admission.rpcSetVersion,
        protocolFeatures: [...frame.params.admission.handshake.protocolFeatures],
        credentialExpiresAtMs: Date.now() + 60_000,
        policy: {
          heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 60_000,
          maxPayload: 25 * 1024 * 1024,
        },
      },
    });
  }

  private handleHeartbeat(socket: WebSocket, frame: WorkerHeartbeatRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.ignoreHeartbeat) {
      return;
    }
    if (this.options.heartbeatFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker heartbeat rejected",
          details: { reason: this.options.heartbeatFailure },
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { receivedAtMs: Date.now(), status: "ok", ownerEpoch: OWNER_EPOCH },
    });
  }

  private handleInferenceCancel(socket: WebSocket, frame: WorkerInferenceCancelRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.outageOnInferenceCancel) {
      this.unavailable = true;
      socket.terminate();
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "cancelled" },
    });
  }

  private handleSessionTool(
    socket: WebSocket,
    frame: {
      id: string;
      method: "worker.sessions.spawn" | "worker.sessions.send" | "worker.github.publish";
      params: WorkerSessionsSpawnParams | WorkerSessionsSendParams | WorkerGitHubPublishParams;
    },
  ): void {
    this.methods.push(frame.method);
    if (frame.method === "worker.sessions.spawn") {
      this.sessionSpawnRequests.push(structuredClone(frame.params as WorkerSessionsSpawnParams));
    } else if (frame.method === "worker.sessions.send") {
      this.sessionSendRequests.push(structuredClone(frame.params as WorkerSessionsSendParams));
    } else {
      this.githubPublishRequests.push(structuredClone(frame.params as WorkerGitHubPublishParams));
    }
    const requestCount =
      this.sessionSpawnRequests.length +
      this.sessionSendRequests.length +
      this.githubPublishRequests.length;
    if (requestCount <= (this.options.silenceSessionToolResponses ?? 0)) {
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        resultJson: JSON.stringify({
          content: [{ type: "text", text: "child accepted" }],
          details: { status: "accepted", childSessionKey: "agent:main:cloud-child" },
        }),
      },
    });
  }

  private handleTranscript(socket: WebSocket, frame: WorkerTranscriptCommitRequestFrame): void {
    this.methods.push(frame.method);
    this.transcriptRequests.push(structuredClone(frame.params));
    if (this.options.silenceFirstTranscript && !this.droppedTranscript) {
      this.droppedTranscript = true;
      return;
    }
    if (this.transcriptRequests.length === this.options.transcriptFailureAtRequest) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker transcript commit rejected",
          details: { reason: "stale-base-leaf" },
        },
      });
      return;
    }
    this.acceptedTranscriptRequests.push(structuredClone(frame.params));
    this.applicationOrder.push(`transcript:${frame.params.seq}`);
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        entryIds: frame.params.messages.map(
          (_message, index) => `entry-${frame.params.seq}-${index}`,
        ),
        newLeafId: `leaf-${frame.params.seq}`,
      },
    });
  }

  private handleLiveEvent(socket: WebSocket, frame: WorkerLiveEventRequestFrame): void {
    this.methods.push(frame.method);
    this.liveEventRequests.push(structuredClone(frame.params));
    this.applicationOrder.push(
      frame.params.event.kind === "lifecycle"
        ? `live:lifecycle:${frame.params.event.payload.phase}`
        : `live:${frame.params.event.kind}`,
    );
    if (this.options.silenceFirstLiveEvent && !this.droppedLiveEvent) {
      this.droppedLiveEvent = true;
      return;
    }
    if (
      this.options.liveResyncAckedSeq !== undefined &&
      this.sentLiveResync < (this.options.liveResyncResponses ?? 1)
    ) {
      this.sentLiveResync += 1;
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker live event rejected",
          details: {
            reason: "resync-required",
            ackedSeq: this.options.liveResyncAckedSeq,
            expectedSeq: this.options.liveResyncAckedSeq + 1,
          },
        },
      });
      return;
    }
    if (this.options.liveFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker live event rejected",
          details: { reason: this.options.liveFailure },
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { ackedSeq: frame.params.seq },
    });
  }

  private handleInference(socket: WebSocket, frame: WorkerInferenceStartRequestFrame): void {
    this.methods.push(frame.method);
    this.inferenceRequests.push(structuredClone(frame.params));
    if (this.inferencePlanIndex === 0 && this.options.execApprovals) {
      saveExecApprovals(this.options.execApprovals);
    }
    this.inferenceStarted.resolve();
    if (this.options.silenceFirstInference && !this.droppedInference) {
      this.droppedInference = true;
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "accepted" },
    });
    const plan = this.options.inferencePlans?.[this.inferencePlanIndex] ?? "text";
    this.inferencePlanIndex += 1;
    if (plan === "hold") {
      return;
    }
    if (plan === "fence") {
      setTimeout(() => socket.close(1008, "owner-epoch-mismatch"), 5);
      return;
    }
    if (plan === "error" || plan === "cancelled") {
      this.sendTerminalOutcome(socket, frame.params, 1, {
        type: "error",
        reason: plan === "error" ? "provider-error" : "cancelled",
        message: plan === "error" ? "fixture provider failed" : "fixture inference cancelled",
      });
      return;
    }
    if (plan === "tool" || plan === "safe-tool" || plan === "background-tool") {
      this.sendToolTurn(socket, frame.params, {
        background: plan === "background-tool",
        safe: plan === "safe-tool",
      });
      return;
    }
    if (plan === "session-tool") {
      this.sendSessionToolTurn(socket, frame.params);
      return;
    }
    if (plan === "burst-text") {
      this.sendBurstTextTurn(socket, frame.params);
      return;
    }
    if (plan === "oversized-text") {
      this.sendBurstTextTurn(socket, frame.params, 1_700);
      return;
    }
    if (plan === "oversized-error") {
      this.sendBurstTextTurn(socket, frame.params, 1_700, "error");
      return;
    }
    if (plan === "empty-terminal") {
      this.sendEmptyTerminalTurn(socket, frame.params);
      return;
    }
    this.sendTextTurn(socket, frame.params, plan === "length" ? "length" : "stop");
  }

  private sendBurstTextTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    chunkCount = 1_100,
    terminal: "done" | "error" = "done",
  ): void {
    const chunk = "x".repeat(40);
    this.send(socket, {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...this.identity(identity),
        seq: 1,
        event: {
          type: "start",
          resolvedModel: { api: "openai-responses", ...MODEL_REF },
          timestamp: Date.now(),
        },
      },
    } satisfies WorkerInferenceEventFrame);
    this.send(socket, {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...this.identity(identity),
        seq: 2,
        event: { type: "text_start", contentIndex: 0 },
      },
    } satisfies WorkerInferenceEventFrame);
    for (let index = 0; index < chunkCount; index += 1) {
      this.send(socket, {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: index + 3,
          event: { type: "text_delta", contentIndex: 0, delta: chunk },
        },
      } satisfies WorkerInferenceEventFrame);
    }
    const text = chunk.repeat(chunkCount);
    if (terminal === "error") {
      this.sendTerminalOutcome(socket, identity, chunkCount + 3, {
        type: "error",
        reason: "provider-error",
        message: "fixture provider failed after streaming",
      });
    } else {
      this.sendTerminal(
        socket,
        identity,
        chunkCount + 3,
        assistantMessage([{ type: "text", text }], "stop"),
      );
    }
  }

  private sendEmptyTerminalTurn(socket: WebSocket, identity: WorkerInferenceStartParams): void {
    this.send(socket, {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...this.identity(identity),
        seq: 1,
        event: {
          type: "start",
          resolvedModel: { api: "openai-responses", ...MODEL_REF },
          timestamp: Date.now(),
        },
      },
    } satisfies WorkerInferenceEventFrame);
    this.send(socket, {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...this.identity(identity),
        seq: 2,
        event: { type: "text_start", contentIndex: 0 },
      },
    } satisfies WorkerInferenceEventFrame);
    this.send(socket, {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...this.identity(identity),
        seq: 3,
        event: { type: "text_delta", contentIndex: 0, delta: "discarded draft" },
      },
    } satisfies WorkerInferenceEventFrame);
    this.sendTerminal(socket, identity, 4, assistantMessage([], "stop"));
  }

  private sendTextTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    stopReason: "stop" | "length" = "stop",
  ): void {
    const events: WorkerInferenceEventFrame[] = [
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 1,
          event: {
            type: "start",
            resolvedModel: { api: "openai-responses", ...MODEL_REF },
            timestamp: Date.now(),
          },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 2,
          event: { type: "text_start", contentIndex: 0 },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 3,
          event: { type: "text_delta", contentIndex: 0, delta: "worker reply" },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 4,
          event: { type: "text_end", contentIndex: 0 },
        },
      },
    ];
    for (const event of events) {
      this.send(socket, event);
    }
    this.sendTerminal(
      socket,
      identity,
      5,
      assistantMessage([{ type: "text", text: "worker reply" }], stopReason),
    );
  }

  private sendToolTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    options: { background: boolean; safe: boolean },
  ): void {
    const toolCallId = "local-exec-call";
    const args = options.background
      ? {
          // POSIX sleep avoids Node startup; Windows keeps the portable Node fixture.
          command:
            process.platform === "win32"
              ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                  "setInterval(() => undefined, 1000)",
                )}`
              : "exec sleep 60",
          background: true,
        }
      : {
          command: options.safe ? "wc -c" : "printf worker-local > local-proof.txt",
        };
    this.sendToolCallTurn(socket, identity, {
      args,
      toolCallId,
      toolName: "exec",
    });
  }

  private sendSessionToolTurn(socket: WebSocket, identity: WorkerInferenceStartParams): void {
    this.sendToolCallTurn(socket, identity, {
      args: { task: "start a nested cloud child" },
      toolCallId: "nested-session-spawn-call",
      toolName: "sessions_spawn",
    });
  }

  private sendToolCallTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    tool: { args: Record<string, unknown>; toolCallId: string; toolName: string },
  ): void {
    const { args, toolCallId, toolName } = tool;
    const encodedArgs = JSON.stringify(args);
    const events: WorkerInferenceEventFrame[] = [
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 1,
          event: {
            type: "start",
            resolvedModel: { api: "openai-responses", ...MODEL_REF },
            timestamp: Date.now(),
          },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 2,
          event: { type: "toolcall_start", contentIndex: 0, id: toolCallId, toolName },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 3,
          event: { type: "toolcall_delta", contentIndex: 0, delta: encodedArgs },
        },
      },
      {
        type: "event",
        event: "worker.inference.event",
        payload: {
          ...this.identity(identity),
          seq: 4,
          event: { type: "toolcall_end", contentIndex: 0 },
        },
      },
    ];
    for (const event of events) {
      this.send(socket, event);
    }
    this.sendTerminal(
      socket,
      identity,
      5,
      assistantMessage(
        [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
        "toolUse",
      ),
    );
  }

  private sendTerminal(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    seq: number,
    message: WorkerDoneMessage,
  ): void {
    this.sendTerminalOutcome(socket, identity, seq, { type: "done", message });
  }

  private sendTerminalOutcome(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    seq: number,
    outcome: WorkerInferenceTerminalOutcome,
  ): void {
    const frame: WorkerInferenceTerminalFrame = {
      type: "event",
      event: "worker.inference.terminal",
      payload: { ...this.identity(identity), seq, outcome },
    };
    this.send(socket, frame);
  }

  private identity(params: WorkerInferenceStartParams) {
    return {
      runEpoch: params.runEpoch,
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
    };
  }

  private send(socket: WebSocket, frame: object): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

function descriptor(socketPath: string, workspaceDir: string): WorkerLaunchDescriptor {
  return {
    version: 4,
    connectionEndpoint: { kind: "unix", socketPath },
    admission: {
      environmentId: "worker-environment",
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      ownerEpoch: OWNER_EPOCH,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "worker-test",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "worker-agent",
      runId: RUN_ID,
      operationalRunInstance: createOperationalRunInstanceRef(RUN_ID),
      agentRuntimeIdentityToken: "test-agent-runtime-token",
      turnId: "worker-turn",
      prompt: "Complete the worker turn.",
      suppressPromptTranscript: false,
      workspaceDir,
      modelRef: MODEL_REF,
      inferenceOptions: { reasoning: "off" },
      initialMessages: [],
      transcript: { baseLeafId: "leaf-base", nextSeq: 3 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: {
        allowedToolNames: ["read", "write", "edit", "apply_patch", "exec", "process"],
      },
    },
  };
}

const gateways: FakeWorkerGateway[] = [];
const tempDirs: string[] = [];

async function setup(options?: FakeGatewayOptions): Promise<{
  gateway: FakeWorkerGateway;
  workspaceDir: string;
  launch: WorkerLaunchDescriptor;
}> {
  const gateway = new FakeWorkerGateway(options);
  gateways.push(gateway);
  await gateway.start();
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-workspace-"));
  tempDirs.push(workspaceDir);
  return { gateway, workspaceDir, launch: descriptor(gateway.socketPath, workspaceDir) };
}

afterEach(async () => {
  browserRuntimeMocks.createWorkerBrowserToolRuntime.mockClear();
  browserRuntimeMocks.dispose.mockClear();
  for (const gateway of gateways.splice(0)) {
    await gateway.stop();
  }
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("worker runtime", () => {
  it("runs a full embedded turn through remote inference, live events, and transcript commits", async () => {
    const { gateway, workspaceDir, launch } = await setup();
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "worker-bootstrap-marker", "utf8");

    const result = await runWorkerDescriptor(launch);

    expect(result.status).toBe("completed");
    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.inferenceRequests[0]?.modelRef).toEqual(MODEL_REF);
    expect(gateway.inferenceRequests[0]?.context.systemPrompt).toContain("worker-bootstrap-marker");
    const toolNames = gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toHaveLength(6);
    const terminalIndex = gateway.applicationOrder.findIndex(
      (entry) => entry === "live:lifecycle:finishing",
    );
    const finalTranscriptIndex = gateway.applicationOrder.findLastIndex((entry) =>
      entry.startsWith("transcript:"),
    );
    expect(finalTranscriptIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(finalTranscriptIndex);
    expect(toolNames).toEqual(
      expect.arrayContaining(["read", "write", "edit", "apply_patch", "exec", "process"]),
    );
    expect(gateway.liveEventRequests.some((request) => request.event.kind === "assistant")).toBe(
      true,
    );
    const lifecycleEvents = gateway.liveEventRequests.flatMap((request) =>
      request.event.kind === "lifecycle" ? [request.event.payload.phase] : [],
    );
    expect(lifecycleEvents).toContain("start");
    expect(lifecycleEvents).toContain("finishing");
    expect(lifecycleEvents).not.toContain("end");
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing", stopReason: "stop" },
    });
    expect(gateway.transcriptRequests.length).toBeGreaterThan(0);
    expect(gateway.transcriptRequests.map((request) => request.seq)).toEqual(
      gateway.transcriptRequests.map((_request, index) => index + 3),
    );
    expect(
      gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    const lastTranscript = gateway.transcriptRequests.at(-1);
    expect(result).toMatchObject({
      transcriptLeafId: `leaf-${lastTranscript?.seq}`,
      transcriptNextSeq: (lastTranscript?.seq ?? 0) + 1,
    });
  });

  it("exposes exactly the Gateway-authorized worker tools", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
    ];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
    ]);
  });

  it("runs with no tools when the Gateway authority is empty", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools ?? []).toEqual([]);
  });

  it("materializes exactly the Browser tool for a browser-only assignment", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = ["browser"];
    launch.assignment.browser = {
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
    };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "browser",
    ]);
    expect(browserRuntimeMocks.createWorkerBrowserToolRuntime).toHaveBeenCalledWith({
      descriptor: launch.assignment.browser,
      sessionKey: `worker:${SESSION_ID}`,
      stateDir: expect.any(String),
      workspaceDir: await realpath(launch.assignment.workspaceDir),
    });
    expect(browserRuntimeMocks.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { authority: ["browser"] as const, browser: undefined },
    {
      authority: ["read"] as const,
      browser: {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      },
    },
  ])("fails before inference when Browser authority and descriptor disagree", async (testCase) => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [...testCase.authority];
    if (testCase.browser) {
      launch.assignment.browser = testCase.browser;
    } else {
      delete launch.assignment.browser;
    }

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "Worker Browser authority and launch descriptor must be provided together",
    );
    expect(gateway.inferenceRequests).toHaveLength(0);
  });

  it("runs an authorized nested-session tool through the closed worker RPC", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["session-tool", "text"] });
    launch.assignment.toolAuthority.allowedToolNames = ["sessions_spawn"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.sessionSpawnRequests).toEqual([
      {
        toolCallId: "nested-session-spawn-call",
        task: "start a nested cloud child",
      },
    ]);
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.transcriptRequests.flatMap((request) =>
        request.messages.flatMap((message) =>
          message.role === "toolResult" ? [message.toolName] : [],
        ),
      ),
    ).toContain("sessions_spawn");
  });

  it.each([
    {
      name: "spawn",
      invoke: (connection: ReturnType<typeof createWorkerConnection>) =>
        connection.requestSessionsSpawn({
          toolCallId: "call-durable-spawn",
          task: "start a nested cloud child",
        }),
      requests: (gateway: FakeWorkerGateway) => gateway.sessionSpawnRequests,
      request: { toolCallId: "call-durable-spawn", task: "start a nested cloud child" },
    },
    {
      name: "send",
      invoke: (connection: ReturnType<typeof createWorkerConnection>) =>
        connection.requestSessionsSend({
          toolCallId: "call-durable-send",
          sessionKey: "agent:main:cloud-child",
          message: "status",
        }),
      requests: (gateway: FakeWorkerGateway) => gateway.sessionSendRequests,
      request: {
        toolCallId: "call-durable-send",
        sessionKey: "agent:main:cloud-child",
        message: "status",
      },
    },
    {
      name: "publish",
      invoke: (connection: ReturnType<typeof createWorkerConnection>) =>
        connection.requestGitHubPublish({
          toolCallId: "call-durable-publish",
          title: "Publish the fix",
        }),
      requests: (gateway: FakeWorkerGateway) => gateway.githubPublishRequests,
      request: { toolCallId: "call-durable-publish", title: "Publish the fix" },
    },
  ])("replays the same durable $name operation across response loss", async (testCase) => {
    const { gateway, launch } = await setup({
      heartbeatIntervalMs: 1,
      ignoreHeartbeat: true,
      silenceSessionToolResponses: 2,
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 25,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    const states: WorkerConnectionState["kind"][] = [];
    connection.onStateChange((state) => states.push(state.kind));
    await connection.start();

    const response = await testCase.invoke(connection);

    expect(response).toMatchObject({
      ok: true,
      payload: { resultJson: expect.stringContaining("child accepted") },
    });
    expect(gateway.connectionCount).toBe(3);
    expect(states).toContain("reconnecting");
    expect(testCase.requests(gateway)).toEqual([
      testCase.request,
      testCase.request,
      testCase.request,
    ]);
    await connection.stop();
  });

  it("fail-stops a stale mid-run transcript without duplicating or rebasing the paid tail", async () => {
    const { gateway, launch } = await setup({ transcriptFailureAtRequest: 2 });

    const failure: unknown = await runWorkerDescriptor(launch).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "WorkerTranscriptCommitError",
      message:
        "Worker transcript base changed; uncommitted messages were not committed; relaunch required.",
      reason: "stale-base-leaf",
    });
    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.transcriptRequests.map((request) => request.seq)).toEqual([3, 4]);
    expect(
      gateway.transcriptRequests.map((request) => request.messages.map((message) => message.role)),
    ).toEqual([["user"], ["assistant"]]);
    expect(gateway.acceptedTranscriptRequests.map((request) => request.seq)).toEqual([3]);
    expect(
      gateway.liveEventRequests.some(
        (request) => request.event.kind === "lifecycle" && request.event.payload.phase === "error",
      ),
    ).toBe(false);
  });

  it("renumbers live events after a gateway cursor reset without aborting the run", async () => {
    const { gateway, launch } = await setup({ liveResyncAckedSeq: 0 });
    launch.assignment.liveEvents = { ackedSeq: 5, nextSeq: 6 };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.acceptedTranscriptRequests).toHaveLength(2);
    expect(gateway.liveEventRequests.slice(0, 2)).toEqual([
      expect.objectContaining({ seq: 6, lastAckedSeq: 5 }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
    ]);
    expect(gateway.liveEventRequests[1]?.event).toEqual(gateway.liveEventRequests[0]?.event);
  });

  it("requires authoritative terminal delivery after degrading preview live events", async () => {
    const { gateway, launch } = await setup({ liveFailure: "capacity-exceeded" });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker live event rejected");

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(
      gateway.acceptedTranscriptRequests
        .flatMap((request) => request.messages)
        .map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(gateway.liveEventRequests.length).toBeGreaterThanOrEqual(2);
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing" },
    });
  });

  it("degrades a repeated no-progress live resync without hanging the run", async () => {
    const { gateway, launch } = await setup({
      liveResyncAckedSeq: 0,
      liveResyncResponses: 2,
    });
    launch.assignment.liveEvents = { ackedSeq: 5, nextSeq: 6 };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.acceptedTranscriptRequests).toHaveLength(2);
    expect(gateway.liveEventRequests).toHaveLength(3);
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing" },
    });
  });

  it("fails closed when worker admission is rejected", async () => {
    const { gateway, launch } = await setup({ admissionFailure: "invalid-credential" });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker admission rejected");
    expect(gateway.connectionCount).toBe(1);
  });

  it("exits cleanly when admission observes a superseded owner epoch", async () => {
    const { launch } = await setup({ admissionFailure: "owner-epoch-mismatch" });

    await expect(runWorkerDescriptor(launch)).resolves.toEqual({
      status: "fenced",
      reason: "owner-epoch-mismatch",
    });
  });

  it("exits cleanly when the owner epoch supersedes the worker", async () => {
    const { launch } = await setup({ inferencePlans: ["fence"] });

    await expect(runWorkerDescriptor(launch)).resolves.toEqual({
      status: "fenced",
      reason: "owner-epoch-mismatch",
    });
  });

  it("sends remote inference cancellation before stopping an active worker", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["hold"] });
    const controller = new AbortController();
    const result = runWorkerDescriptor(launch, { signal: controller.signal });
    await gateway.waitForInferenceStart();

    controller.abort(new Error("operator stopped worker"));

    await expect(result).rejects.toThrow("operator stopped worker");
    expect(gateway.methods).toContain("worker.inference.cancel");
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing", aborted: true },
    });
  });

  it("bounds shutdown when remote inference cancellation cannot settle", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["hold"],
      outageOnInferenceCancel: true,
    });
    const controller = new AbortController();
    const result = runWorkerDescriptor(launch, { signal: controller.signal });
    await gateway.waitForInferenceStart();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const rejected = expect(result).rejects.toThrow("operator stopped worker during outage");

      controller.abort(new Error("operator stopped worker during outage"));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(gateway.methods).toContain("worker.inference.cancel");
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["error", "error", "finishing", { status: "failed", reason: "turn-failed" }],
    ["cancelled", "aborted", "finishing", { status: "failed", reason: "turn-failed" }],
    ["length", "length", "finishing", { status: "completed" }],
  ] as const)(
    "reports remote inference %s terminal reasons",
    async (plan, stopReason, lifecyclePhase, expectedResult) => {
      const { gateway, launch } = await setup({ inferencePlans: [plan] });

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject(expectedResult);
      const assistant = gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .toReversed()
        .find((entry) => entry.role === "assistant");
      expect(assistant).toMatchObject({ stopReason });
      const lifecycle = gateway.liveEventRequests
        .map((request) => request.event)
        .toReversed()
        .find((event) => event.kind === "lifecycle");
      expect(lifecycle).toMatchObject({
        payload: { phase: lifecyclePhase, stopReason },
      });
    },
  );

  it("keeps an unacknowledged failed-turn terminal as an infrastructure failure", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["error"],
      liveFailure: "capacity-exceeded",
    });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker live event rejected");
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing" },
    });
  });

  it("fails closed when a heartbeat is rejected without fencing", async () => {
    const { launch } = await setup({
      inferencePlans: ["hold"],
      heartbeatFailure: "credential-expired",
      heartbeatIntervalMs: 1,
    });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "worker heartbeat rejected: credential-expired",
    );
  });

  it("coalesces bursty live output and keeps every frame below the byte ceiling", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["burst-text"] });

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    const assistantEvents = gateway.liveEventRequests.filter(
      (request) => request.event.kind === "assistant",
    );
    expect(assistantEvents.length).toBeGreaterThan(0);
    expect(assistantEvents.length).toBeLessThan(1_100);
    for (const request of gateway.liveEventRequests) {
      expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(64 * 1024);
    }
  });

  it.each(["oversized-text", "oversized-error"] as const)(
    "turns %s output into a persistable failed turn",
    async (plan) => {
      const { gateway, launch } = await setup({ inferencePlans: [plan] });

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
        status: "failed",
        reason: "turn-failed",
        transcriptLeafId: expect.any(String),
        transcriptNextSeq: expect.any(Number),
      });
      const assistant = gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .toReversed()
        .find((message) => message.role === "assistant");
      expect(assistant).toMatchObject({ role: "assistant", stopReason: "error", content: [] });
      for (const request of gateway.transcriptRequests) {
        expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(64 * 1024);
      }
    },
  );

  it("clears streamed text when the authoritative terminal message is empty", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["empty-terminal"] });

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    const finalAssistant = gateway.liveEventRequests
      .map((request) => request.event)
      .toReversed()
      .find((event) => event.kind === "assistant");
    expect(finalAssistant).toEqual({
      kind: "assistant",
      payload: { text: "", delta: "", replace: true },
    });
  });

  it("stops worker-scoped background processes when fenced", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["background-tool", "fence"],
    });

    await expect(runWorkerDescriptor(launch)).resolves.toEqual({
      status: "fenced",
      reason: "owner-epoch-mismatch",
    });
    expect(gateway.inferenceRequests).toHaveLength(2);
    await waitForFast(
      () => {
        expect(
          listRunningSessions().filter((session) => session.scopeKey === `worker:${SESSION_ID}`),
        ).toHaveLength(0);
      },
      { timeout: 7_000 },
    );
  });

  it("executes coding tools locally without reading the preexisting auth profile", async () => {
    const { gateway, workspaceDir, launch } = await setup({ inferencePlans: ["tool", "text"] });
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const trapStateDir = path.join(workspaceDir, "state-trap");
    const authDir = path.join(trapStateDir, "agents", "main", "agent");
    const configTrap = path.join(workspaceDir, "config-trap");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth-profiles.json"), "not valid json", "utf8");
    await mkdir(configTrap);
    process.env.OPENCLAW_STATE_DIR = trapStateDir;
    process.env.OPENCLAW_CONFIG_PATH = configTrap;
    try {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
    }

    await expect(readFile(path.join(workspaceDir, "local-proof.txt"), "utf8")).resolves.toBe(
      "worker-local",
    );
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.inferenceRequests[1]?.context.messages.some(
        (message) => message.role === "toolResult",
      ),
    ).toBe(true);
    expect(
      gateway.methods.every((method) => method.startsWith("worker.") || method === "connect"),
    ).toBe(true);
  });

  it.each([
    {
      mode: "read-only" as const,
      omittedTools: ["write", "edit", "apply_patch"],
      denial: /host=gateway security=deny/u,
    },
    {
      mode: "guarded" as const,
      omittedTools: [],
      denial:
        /approval_required.*worker guarded permission mode.*run this command locally.*interactive approval.*administrator.*clear the session permission mode/isu,
    },
    {
      mode: "workspace" as const,
      omittedTools: [],
      denial:
        /approval_required.*worker workspace permission mode.*run this command locally.*interactive approval.*administrator.*clear the session permission mode/isu,
    },
    { mode: "full" as const, omittedTools: [], denial: null },
  ])("applies the $mode worker permission clamp", async ({ mode, omittedTools, denial }) => {
    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: ["tool", "text"],
      ...(mode === "full"
        ? {
            execApprovals: {
              version: 1,
              defaults: { security: "full", ask: "always" },
              agents: {},
            },
          }
        : {}),
    });
    launch.assignment.permissionMode = mode;
    launch.assignment.workerContainmentRoot = workspaceDir;

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    const toolNames = gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name) ?? [];
    for (const toolName of omittedTools) {
      expect(toolNames).not.toContain(toolName);
    }
    const toolResult = JSON.stringify(
      gateway.inferenceRequests[1]?.context.messages.find(
        (message) => message.role === "toolResult",
      ),
    );
    if (denial) {
      expect(toolResult).toMatch(denial);
      await expect(
        readFile(path.join(workspaceDir, "local-proof.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(readFile(path.join(workspaceDir, "local-proof.txt"), "utf8")).resolves.toBe(
        "worker-local",
      );
      expect(toolResult).not.toMatch(/approval_required|approval-pending/iu);
      expect(gateway.methods.some((method) => method.includes("approval"))).toBe(false);
    }
  });

  it.each(["guarded", "workspace"] as const)(
    "keeps the %s worker allowlist fast path",
    async (mode) => {
      const { gateway, workspaceDir, launch } = await setup({
        inferencePlans: ["safe-tool", "text"],
      });
      launch.assignment.permissionMode = mode;
      launch.assignment.workerContainmentRoot = workspaceDir;

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

      const toolResult = JSON.stringify(
        gateway.inferenceRequests[1]?.context.messages.find(
          (message) => message.role === "toolResult",
        ),
      );
      expect(toolResult).not.toContain("approval_required");
      expect(toolResult).toMatch(/\b0\b/u);
    },
  );

  it("canonicalizes an in-root worker workspace before enforcing containment", async () => {
    const { workspaceDir, launch } = await setup();
    const nested = path.join(workspaceDir, "nested");
    await mkdir(nested);
    launch.assignment.workspaceDir = path.join(nested, "..", "nested");
    launch.assignment.permissionMode = "workspace";
    launch.assignment.workerContainmentRoot = workspaceDir;

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects a worker workspace outside its canonical containment root", async () => {
    const { workspaceDir, launch } = await setup();
    const narrowerRoot = path.join(workspaceDir, "contained");
    await mkdir(narrowerRoot);
    launch.assignment.permissionMode = "workspace";
    launch.assignment.workerContainmentRoot = narrowerRoot;

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "worker workspace path escapes its assigned containment root",
    );
  });

  it("rejects a dot-dot workspace escape before worker connection", async () => {
    const { workspaceDir, launch } = await setup();
    const outside = await mkdtemp(path.join(tmpdir(), "openclaw-worker-outside-"));
    tempDirs.push(outside);
    launch.assignment.workspaceDir = path.join(workspaceDir, "..", path.basename(outside));
    launch.assignment.permissionMode = "workspace";
    launch.assignment.workerContainmentRoot = workspaceDir;

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "worker workspace path escapes its assigned containment root",
    );
  });

  it("keeps a pinned replay anchor through repeated local tool-loop inference", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["tool", "text"] });
    launch.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 2 },
      (_value, index): WorkerTranscriptMessage => ({
        role: "user",
        content: [{ type: "text", text: `history-${index}` }],
        timestamp: index + 1,
      }),
    );
    launch.assignment.initialMessages[2] = {
      ...assistantMessage([{ type: "text", text: "checkpoint suffix" }], "stop"),
      providerReplay: structuredClone(WORKER_LOOP_REPLAY),
    };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(2);
    for (const request of gateway.inferenceRequests) {
      expect(request.context.messages.length).toBeLessThanOrEqual(
        WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
      );
      expect(request.context.messages[0]?.role).toBe("user");
      expect(
        request.context.messages.find(
          (message) => message.role === "assistant" && message.providerReplay,
        ),
      ).toMatchObject({ providerReplay: WORKER_LOOP_REPLAY });
    }
    expect(
      gateway.inferenceRequests[1]?.context.messages.some(
        (message) => message.role === "toolResult",
      ),
    ).toBe(true);
    expect(
      gateway.inferenceRequests[1]?.context.messages.slice(-3).map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult"]);
    expect(
      gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("fails before a second inference when the replay unit outgrows the window", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["tool", "text"] });
    launch.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES - 1 },
      (_value, index): WorkerTranscriptMessage => ({
        role: "user",
        content: [{ type: "text", text: `history-${index}` }],
        timestamp: index + 1,
      }),
    );
    launch.assignment.initialMessages[0] = {
      ...assistantMessage([{ type: "text", text: "checkpoint suffix" }], "stop"),
      providerReplay: structuredClone(WORKER_LOOP_REPLAY),
    };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
      status: "failed",
      reason: "turn-failed",
      transcriptLeafId: expect.any(String),
      transcriptNextSeq: expect.any(Number),
    });

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.inferenceRequests[0]?.context.messages).toHaveLength(
      WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
    );
    expect(gateway.inferenceRequests[0]?.context.messages[0]).toMatchObject({
      providerReplay: WORKER_LOOP_REPLAY,
    });
    const terminal = gateway.transcriptRequests
      .flatMap((request) => request.messages)
      .toReversed()
      .find((message) => message.role === "assistant");
    expect(terminal).toMatchObject({
      stopReason: "error",
      errorMessage: `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (provider-replay-message-limit)`,
    });
  });
});

describe("worker reconnect clients", () => {
  it("isolates ready listener failures while admitting the worker and starting heartbeats", async () => {
    const { gateway, launch } = await setup({ heartbeatIntervalMs: 1 });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
    });
    let healthyReadyCalls = 0;
    connection.onReady(() => {
      throw new Error("induced ready observer failure");
    });
    connection.onReady(() => {
      healthyReadyCalls += 1;
    });

    try {
      await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
      expect(healthyReadyCalls).toBe(1);
      await waitForFast(() => expect(gateway.methods).toContain("worker.heartbeat"));
    } finally {
      await connection.stop();
    }
  });

  it("fails closed when the overall admission deadline expires", async () => {
    const { gateway, launch } = await setup({ admissionFailure: "gateway-unavailable" });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      admissionTimeoutMs: 25,
      admissionDeadlineMs: 250,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await expect(connection.start()).rejects.toBeInstanceOf(WorkerAdmissionDeadlineExceededError);
      expect(gateway.connectionCount).toBeGreaterThan(1);
      expect(connection.state).toMatchObject({
        kind: "failed",
        error: expect.any(WorkerAdmissionDeadlineExceededError),
      });
      await expect(connection.waitForExit()).resolves.toMatchObject({
        kind: "failed",
        error: expect.any(WorkerAdmissionDeadlineExceededError),
      });
    } finally {
      await connection.stop();
    }
  });

  it("times out a silent admission attempt and admits on reconnect", async () => {
    const { gateway, launch } = await setup({ ignoreFirstAdmission: true });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      admissionTimeoutMs: 25,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      await connection.stop();
    }
  });

  it("times out a silent heartbeat and reconnects", async () => {
    const { gateway, launch } = await setup({
      ignoreHeartbeat: true,
      heartbeatIntervalMs: 1,
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 25,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await connection.start();
      await waitForFast(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2));
    } finally {
      await connection.stop();
    }
  });

  it("replays exact RPC payloads after silent response timeouts", async () => {
    const { gateway, launch } = await setup({
      silenceFirstTranscript: true,
      silenceFirstLiveEvent: true,
      silenceFirstInference: true,
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 40,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    const transcript = new WorkerTranscriptCommitClient(connection, {
      runEpoch: OWNER_EPOCH,
      baseLeafId: "leaf-base",
      initialSeq: 8,
    });
    const live = new WorkerLiveEventClient(connection, { runEpoch: OWNER_EPOCH });
    const inference = new WorkerInferenceProxyClient(connection);
    try {
      await connection.start();
      await transcript.commit([
        {
          role: "user",
          content: [{ type: "text", text: "silent transcript" }],
          timestamp: 1,
        },
      ]);
      live.enqueuePreview(RUN_ID, {
        kind: "assistant",
        payload: { text: "silent live event", delta: "silent live event" },
      });
      await waitForFast(() => expect(gateway.liveEventRequests).toHaveLength(2));
      await live.emitTerminal(RUN_ID, {
        kind: "lifecycle",
        payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
      });
      await inference.start({
        runEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        turnId: "silent-inference",
        modelRef: MODEL_REF,
        context: { messages: [] },
        options: {},
      });

      expect(gateway.transcriptRequests).toHaveLength(2);
      expect(gateway.transcriptRequests[1]).toEqual(gateway.transcriptRequests[0]);
      expect(gateway.liveEventRequests).toHaveLength(3);
      expect(gateway.liveEventRequests[1]).toEqual(gateway.liveEventRequests[0]);
      expect(gateway.inferenceRequests).toHaveLength(2);
      expect(gateway.inferenceRequests[1]).toEqual(gateway.inferenceRequests[0]);
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(4);
    } finally {
      inference.dispose();
      live.dispose();
      await connection.stop();
    }
  });

  it("settles an in-flight commit and a later live emit after stop", async () => {
    const { gateway, launch } = await setup({ silenceFirstTranscript: true });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 5_000,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    const originalWaitForReady = connection.waitForReady.bind(connection);
    const waitForReady = vi.spyOn(connection, "waitForReady").mockImplementation(() => {
      if (waitForReady.mock.calls.length > 4) {
        throw new Error("worker client retried after terminal stop");
      }
      return originalWaitForReady();
    });
    const transcript = new WorkerTranscriptCommitClient(connection, {
      runEpoch: OWNER_EPOCH,
      baseLeafId: "leaf-base",
      initialSeq: 8,
    });
    let live: WorkerLiveEventClient | undefined;
    try {
      await connection.start();
      const commit = transcript.commit([
        {
          role: "user",
          content: [{ type: "text", text: "commit interrupted by stop" }],
          timestamp: 1,
        },
      ]);
      await waitForFast(() => expect(gateway.transcriptRequests).toHaveLength(1));

      await connection.stop();
      await expect(commit).rejects.toBeInstanceOf(WorkerConnectionStoppedError);

      live = new WorkerLiveEventClient(connection, { runEpoch: OWNER_EPOCH });
      live.enqueuePreview(RUN_ID, {
        kind: "assistant",
        payload: { text: "late live event", delta: "late live event" },
      });
      await expect(
        live.emitTerminal(RUN_ID, {
          kind: "lifecycle",
          payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
        }),
      ).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
      expect(waitForReady.mock.calls.length).toBeLessThanOrEqual(2);
      expect(gateway.liveEventRequests).toHaveLength(0);
    } finally {
      live?.dispose();
      await connection.stop();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
