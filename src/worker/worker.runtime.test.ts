import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
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
import { listRunningSessions } from "../agents/bash-process-registry.js";
import { rawDataToString } from "../infra/ws.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { WorkerAdmissionDeadlineExceededError } from "./worker-connection-contract.js";
import { createWorkerConnection, WorkerConnectionStoppedError } from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

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
const BUNDLE_HASH = Array.from({ length: 64 }, () => "a").join("");
const CREDENTIAL = ["worker", "fixture", "admission"].join("-");

type InferencePlan =
  | "text"
  | "tool"
  | "background-tool"
  | "hold"
  | "fence"
  | "error"
  | "cancelled"
  | "burst-text"
  | "oversized-text"
  | "oversized-error"
  | "empty-terminal";
type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

type FakeGatewayOptions = {
  admissionFailure?: "gateway-unavailable" | "invalid-credential" | "owner-epoch-mismatch";
  inferencePlans?: InferencePlan[];
  outageOnInferenceCancel?: boolean;
  ignoreFirstAdmission?: boolean;
  ignoreHeartbeat?: boolean;
  silenceFirstTranscript?: boolean;
  silenceFirstLiveEvent?: boolean;
  silenceFirstInference?: boolean;
  transcriptFailureAtRequest?: number;
  liveResyncAckedSeq?: number;
  liveResyncResponses?: number;
  liveFailure?: "capacity-exceeded";
  heartbeatFailure?: "credential-expired";
  heartbeatIntervalMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantMessage(
  content: WorkerDoneMessage["content"],
  stopReason: "stop" | "toolUse",
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

  socketPath = "";
  connectionCount = 0;
  readonly methods: string[] = [];
  readonly transcriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly acceptedTranscriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly liveEventRequests: WorkerLiveEventParams[] = [];
  readonly inferenceRequests: WorkerInferenceStartParams[] = [];
  readonly applicationOrder: string[] = [];

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
    if (plan === "tool" || plan === "background-tool") {
      this.sendToolTurn(socket, frame.params, plan === "background-tool");
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
    this.sendTextTurn(socket, frame.params);
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

  private sendTextTurn(socket: WebSocket, identity: WorkerInferenceStartParams): void {
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
      assistantMessage([{ type: "text", text: "worker reply" }], "stop"),
    );
  }

  private sendToolTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    background = false,
  ): void {
    const toolCallId = "local-exec-call";
    const args = background
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
      : { command: "printf worker-local > local-proof.txt" };
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
          event: { type: "toolcall_start", contentIndex: 0, id: toolCallId, toolName: "exec" },
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
        [{ type: "toolCall", id: toolCallId, name: "exec", arguments: args }],
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
    version: 2,
    socketPath,
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
      runId: RUN_ID,
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
      (entry) => entry === "live:lifecycle:end",
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
    expect(lifecycleEvents).toContain("end");
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
    launch.assignment.toolAuthority.allowedToolNames = ["read", "exec"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
    ]);
  });

  it("runs with no tools when the Gateway authority is empty", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools ?? []).toEqual([]);
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
      payload: { phase: "end" },
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
      payload: { phase: "end" },
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
    await waitForFast(() => expect(gateway.inferenceRequests).toHaveLength(1));

    controller.abort(new Error("operator stopped worker"));

    await expect(result).rejects.toThrow("operator stopped worker");
    expect(gateway.methods).toContain("worker.inference.cancel");
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "end", aborted: true },
    });
  });

  it("bounds shutdown when remote inference cancellation cannot settle", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["hold"],
      outageOnInferenceCancel: true,
    });
    const controller = new AbortController();
    const result = runWorkerDescriptor(launch, { signal: controller.signal });
    await waitForFast(() => expect(gateway.inferenceRequests).toHaveLength(1));

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
    ["error", "error", "error"],
    ["cancelled", "aborted", "end"],
  ] as const)(
    "reports remote inference %s terminals as failed turns",
    async (plan, stopReason, lifecyclePhase) => {
      const { gateway, launch } = await setup({ inferencePlans: [plan] });

      await expect(runWorkerDescriptor(launch)).resolves.toEqual({
        status: "failed",
        reason: "turn-failed",
      });
      const assistant = gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .toReversed()
        .find((entry) => entry.role === "assistant");
      expect(assistant).toMatchObject({ stopReason });
      const lifecycle = gateway.liveEventRequests
        .map((request) => request.event)
        .toReversed()
        .find((event) => event.kind === "lifecycle");
      expect(lifecycle).toMatchObject({ payload: { phase: lifecyclePhase } });
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
      payload: { phase: "error" },
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

      await expect(runWorkerDescriptor(launch)).resolves.toEqual({
        status: "failed",
        reason: "turn-failed",
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

  it("windows near-limit history for every local tool-loop inference", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["tool", "text"] });
    launch.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES },
      (_value, index): WorkerTranscriptMessage => ({
        role: "user",
        content: [{ type: "text", text: `history-${index}` }],
        timestamp: index + 1,
      }),
    );

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(2);
    for (const request of gateway.inferenceRequests) {
      expect(request.context.messages.length).toBeLessThanOrEqual(
        WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
      );
      expect(request.context.messages[0]?.role).toBe("user");
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
});

describe("worker reconnect clients", () => {
  it("fails closed when the overall admission deadline expires", async () => {
    const { gateway, launch } = await setup({ admissionFailure: "gateway-unavailable" });
    const connection = createWorkerConnection({
      socketPath: gateway.socketPath,
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
      socketPath: gateway.socketPath,
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
      socketPath: gateway.socketPath,
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
      socketPath: gateway.socketPath,
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
      await live.emit(RUN_ID, {
        kind: "assistant",
        payload: { text: "silent live event", delta: "silent live event" },
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
      expect(gateway.liveEventRequests).toHaveLength(2);
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
      socketPath: gateway.socketPath,
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
      await expect(
        live.emit(RUN_ID, {
          kind: "assistant",
          payload: { text: "late live event", delta: "late live event" },
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
