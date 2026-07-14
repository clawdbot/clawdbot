import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  type WorkerLiveEventParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  attachWorkerWsMessageHandler,
  type WorkerConnectionService,
} from "../gateway/server/ws-connection/worker-connection.js";
import type { GatewayWsClient } from "../gateway/server/ws-types.js";
import type { WorkerConnectionIdentity } from "../gateway/worker-environments/connection-identity.js";
import { hashWorkerCredential } from "../gateway/worker-environments/credential.js";
import { createWorkerInferenceStore } from "../gateway/worker-environments/inference-store.js";
import {
  createWorkerLiveEventReceiver,
  type WorkerLiveEventReceiver,
} from "../gateway/worker-environments/live-events.js";
import {
  createWorkerEnvironmentService,
  type WorkerEnvironmentService,
} from "../gateway/worker-environments/service.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentStore,
} from "../gateway/worker-environments/store.js";
import { createWorkerTranscriptCommitStore } from "../gateway/worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "../gateway/worker-environments/transcript-commit.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { rawDataToString } from "../infra/ws.js";
import type { WorkerProvider, WorkerSshEndpoint } from "../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  createWorkerConnection,
  type WorkerConnection,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";

const SESSION_ID = "fault-session";
const SESSION_KEY = "agent:main:fault-session";
const ENVIRONMENT_ID = "fault-environment";
const RUN_ID = "fault-run";
const BUNDLE_HASH = Array.from({ length: 64 }, () => "a").join("");
const CREDENTIAL = ["worker", "fault", "fixture"].join("-");
const REPLACEMENT_CREDENTIAL = ["worker", "replacement", "fixture"].join("-");
const MODEL_REF = { provider: "fake", model: "fault-model" } as const;
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "worker-fixtures", id: "/development-key" },
};
const HANDSHAKE = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "fault-test",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
type WorkerEnvironmentServiceOptions = Parameters<typeof createWorkerEnvironmentService>[0];
const BUNDLE_ARTIFACT = {
  install: "bundle" as const,
  bundleHash: BUNDLE_HASH,
  openclawVersion: HANDSHAKE.openclawVersion,
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
  tarballSha256: Array.from({ length: 64 }, () => "b").join(""),
  tarballPath: "/gateway/cache/worker-bundle.tgz",
};
const PROVIDER: WorkerProvider = {
  id: "fake",
  provision: async () => ({ leaseId: "lease-fault", ssh: SSH_ENDPOINT }),
  inspect: async () => ({ status: "active" }),
  destroy: async () => {},
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

function doneMessage(text: string): WorkerDoneMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: MODEL_REF.provider,
    model: MODEL_REF.model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function doneOutcome(text: string): WorkerInferenceTerminalOutcome {
  return {
    type: "done",
    message: doneMessage(text),
  };
}

function transcriptMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  };
}

function inferenceRequest(epoch: number, turnId: string): WorkerInferenceStartParams {
  return {
    runEpoch: epoch,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    turnId,
    modelRef: MODEL_REF,
    context: { messages: [] },
    options: {},
  };
}

type FaultRule =
  | { kind: "drop-response"; method: string; restart: boolean }
  | { kind: "partition-after-inference-event"; seq: number };

type TranscriptGate = {
  phase: "before-apply" | "after-apply";
  entered: Deferred<void>;
  release: Deferred<void>;
};

type ProviderPlan =
  | { kind: "immediate"; text: string }
  | {
      kind: "partitioned";
      firstRelease: Deferred<void>;
      secondRelease: Deferred<void>;
      started: Deferred<void>;
      text: string;
    }
  | { kind: "pending"; release: Deferred<WorkerInferenceTerminalOutcome>; started: Deferred<void> };

type WorkerClients = {
  connection: WorkerConnection;
  transcript: WorkerTranscriptCommitClient;
  live: WorkerLiveEventClient;
  inference: WorkerInferenceProxyClient;
};

class ComposedGatewayHarness {
  readonly root: string;
  readonly stateDir: string;
  readonly sessionsDir: string;
  readonly storePath: string;
  readonly sessionFile: string;
  readonly socketPath: string;
  readonly cfg: OpenClawConfig;
  readonly database: OpenClawStateDatabase;
  readonly store: WorkerEnvironmentStore;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly admissions: WorkerConnectionIdentity[] = [];
  readonly liveDeltas: string[] = [];
  readonly abandonedServices: WorkerEnvironmentService[] = [];
  providerCalls = 0;
  replacementProviderCalls = 0;
  connectionCount = 0;
  transcriptGate: TranscriptGate | undefined;
  providerPlan: ProviderPlan = { kind: "immediate", text: "done" };

  private readonly httpServer: Server;
  private readonly webSocketServer: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly socketCleanups = new Set<() => void>();
  private readonly requestMethods = new Map<string, string>();
  private readonly faults: FaultRule[] = [];
  private serviceValue!: WorkerEnvironmentService;
  private liveEventsValue!: WorkerLiveEventReceiver;
  private useReplacementExecutor = false;
  private unsubscribeLive: (() => void) | undefined;

  static async create(): Promise<ComposedGatewayHarness> {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-fault-"),
    );
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await upsertSessionEntry(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      { sessionId: SESSION_ID, updatedAt: 1 },
    );
    const sessionFile = (
      await resolveSessionTranscriptRuntimeTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath,
      })
    ).sessionFile;
    return new ComposedGatewayHarness({ root, sessionsDir, storePath, sessionFile });
  }

  private constructor(params: {
    root: string;
    sessionsDir: string;
    storePath: string;
    sessionFile: string;
  }) {
    this.root = params.root;
    this.stateDir = path.join(params.root, "state");
    this.sessionsDir = params.sessionsDir;
    this.storePath = params.storePath;
    this.sessionFile = params.sessionFile;
    this.socketPath = path.join(params.root, "gateway.sock");
    this.cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: {
        mainKey: "main",
        store: path.join(params.root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      cloudWorkers: {
        profiles: { development: { provider: "fake", settings: { region: "test" } } },
      },
    };
    this.database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: this.stateDir } });
    this.store = createWorkerEnvironmentStore({ database: this.database });
    this.seedAttachedEnvironment();
    this.liveEventsValue = this.createLiveEvents(true);
    this.serviceValue = this.createService();
    this.httpServer = createServer();
    this.webSocketServer = new WebSocketServer({ server: this.httpServer });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));
    this.unsubscribeLive = onAgentRuntimeEvent((event) => {
      if (typeof event.data.delta === "string") {
        this.liveDeltas.push(event.data.delta);
      }
    });
  }

  get service(): WorkerEnvironmentService {
    return this.serviceValue;
  }

  get epoch(): number {
    const record = this.store.get(ENVIRONMENT_ID);
    if (!record) {
      throw new Error("fault environment missing");
    }
    return record.ownerEpoch;
  }

  async start(): Promise<void> {
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

  addFault(rule: FaultRule): void {
    this.faults.push(rule);
  }

  createClients(
    params: {
      admissionProof?: string;
      epoch?: number;
      baseLeafId?: string | null;
      initialSeq?: number;
      initialAckedSeq?: number;
      runId?: string;
    } = {},
  ): WorkerClients {
    const epoch = params.epoch ?? this.epoch;
    const credential = params.admissionProof ?? CREDENTIAL;
    const descriptor: WorkerLaunchDescriptor = {
      version: 1,
      socketPath: this.socketPath,
      admission: {
        environmentId: ENVIRONMENT_ID,
        credential,
        sessionId: SESSION_ID,
        ownerEpoch: epoch,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: HANDSHAKE,
      },
      assignment: {
        runId: params.runId ?? RUN_ID,
        turnId: "fault-turn",
        prompt: "fault injection",
        workspaceDir: this.root,
        modelRef: MODEL_REF,
        inferenceOptions: {},
        suppressPromptTranscript: false,
        initialMessages: [],
        transcript: { baseLeafId: params.baseLeafId ?? null, nextSeq: params.initialSeq ?? 1 },
        liveEvents: {
          ackedSeq: params.initialAckedSeq ?? 0,
          nextSeq: (params.initialAckedSeq ?? 0) + 1,
        },
      },
    };
    const connection = createWorkerConnection({
      socketPath: this.socketPath,
      connectParams: buildWorkerConnectParams(descriptor),
      admissionTimeoutMs: 1_000,
      admissionDeadlineMs: 5_000,
      requestTimeoutMs: 2_000,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    return {
      connection,
      transcript: new WorkerTranscriptCommitClient(connection, {
        runEpoch: epoch,
        baseLeafId: params.baseLeafId ?? null,
        initialSeq: params.initialSeq ?? 1,
      }),
      live: new WorkerLiveEventClient(connection, {
        runEpoch: epoch,
        initialAckedSeq: params.initialAckedSeq ?? 0,
      }),
      inference: new WorkerInferenceProxyClient(connection),
    };
  }

  hardRestart(options: { corroborateLiveOwner: boolean }): void {
    const previous = this.serviceValue;
    this.abandonedServices.push(previous);
    this.liveEventsValue.clear();
    this.liveEventsValue = this.createLiveEvents(options.corroborateLiveOwner);
    this.useReplacementExecutor = true;
    this.serviceValue = this.createService();
    this.terminateSockets();
  }

  partition(): void {
    this.terminateSockets();
  }

  reclaimWithCredential(credential: string): number {
    const attached = this.store.get(ENVIRONMENT_ID);
    if (!attached || attached.state !== "attached") {
      throw new Error("fault environment is not attached");
    }
    const idle = this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "attached",
      to: "idle",
      expectedOwnerEpoch: attached.ownerEpoch,
    });
    const next = this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "idle",
      to: "attached",
      expectedOwnerEpoch: idle.ownerEpoch,
      patch: {
        attachedSessionIds: [SESSION_ID],
        credential: {
          credentialHash: hashWorkerCredential(credential),
          sessionId: SESSION_ID,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: Date.now() + 60_000,
        },
      },
    });
    this.liveEventsValue.clearEnvironment(ENVIRONMENT_ID);
    if (
      !this.liveEventsValue.bindSession({
        environmentId: ENVIRONMENT_ID,
        runEpoch: next.ownerEpoch,
        sessionId: SESSION_ID,
      })
    ) {
      throw new Error("replacement live-event binding failed");
    }
    return next.ownerEpoch;
  }

  requestParams(method: string): unknown[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => structuredClone(request.params));
  }

  async close(): Promise<void> {
    this.transcriptGate?.release.resolve();
    if (this.providerPlan.kind === "partitioned") {
      this.providerPlan.firstRelease.resolve();
      this.providerPlan.secondRelease.resolve();
    } else if (this.providerPlan.kind === "pending") {
      this.providerPlan.release.resolve({
        type: "error",
        reason: "provider-error",
        message: "fixture released during cleanup",
      });
    }
    this.terminateSockets();
    for (const cleanup of this.socketCleanups) {
      cleanup();
    }
    this.socketCleanups.clear();
    await this.serviceValue.stop();
    for (const service of this.abandonedServices) {
      await service.stop();
    }
    this.liveEventsValue.clear();
    this.unsubscribeLive?.();
    this.unsubscribeLive = undefined;
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
    closeOpenClawStateDatabaseForTest();
    await fs.rm(this.root, { recursive: true, force: true });
  }

  private seedAttachedEnvironment(): void {
    const intent = this.store.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:fault-environment",
    });
    const provisioning = this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: intent.state,
      to: "provisioning",
    });
    const bootstrapping = this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: provisioning.state,
      to: "bootstrapping",
      patch: { leaseId: "lease-fault", sshEndpoint: SSH_ENDPOINT },
    });
    const ready = this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: bootstrapping.state,
      to: "ready",
      patch: {
        bootstrapReceipt: HANDSHAKE,
        credential: {
          credentialHash: hashWorkerCredential([CREDENTIAL, "ready"].join("-")),
          sessionId: null,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: Date.now() + 60_000,
        },
      },
    });
    this.store.transition({
      environmentId: ENVIRONMENT_ID,
      from: ready.state,
      to: "attached",
      patch: {
        attachedSessionIds: [SESSION_ID],
        credential: {
          credentialHash: hashWorkerCredential(CREDENTIAL),
          sessionId: SESSION_ID,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: Date.now() + 60_000,
        },
      },
    });
  }

  private createLiveEvents(corroborateOwner: boolean): WorkerLiveEventReceiver {
    const binding = {
      environmentId: ENVIRONMENT_ID,
      runEpoch: this.epoch,
      sessionId: SESSION_ID,
    };
    const receiver = createWorkerLiveEventReceiver({
      getConfig: () => this.cfg,
      startupBindings: corroborateOwner ? [binding] : [],
      startupOwners: corroborateOwner
        ? new Map([[ENVIRONMENT_ID, this.epoch]])
        : new Map<string, number>(),
    });
    receiver.start();
    if (!corroborateOwner && !receiver.bindSession(binding)) {
      throw new Error("live-event restart binding failed");
    }
    return receiver;
  }

  private createService(): WorkerEnvironmentService {
    const ledger = createWorkerTranscriptCommitStore({ database: this.database });
    const committer = createWorkerTranscriptCommitter({
      getConfig: () => this.cfg,
      store: ledger,
    });
    const executeInference: WorkerEnvironmentServiceOptions["executeInference"] = async (
      params,
    ) => {
      if (this.useReplacementExecutor) {
        this.replacementProviderCalls += 1;
      } else {
        this.providerCalls += 1;
      }
      const plan = this.providerPlan;
      if (plan.kind === "immediate") {
        return doneOutcome(plan.text);
      }
      if (plan.kind === "pending") {
        plan.started.resolve();
        return await plan.release.promise;
      }
      plan.started.resolve();
      params.emit({ type: "text_delta", contentIndex: 0, delta: "first" });
      await plan.firstRelease.promise;
      params.emit({ type: "text_delta", contentIndex: 0, delta: "second" });
      await plan.secondRelease.promise;
      return doneOutcome(plan.text);
    };
    return createWorkerEnvironmentService({
      store: this.store,
      getConfig: () => this.cfg,
      resolveProvider: (providerId) => (providerId === PROVIDER.id ? PROVIDER : undefined),
      prepareInstallation: async () => BUNDLE_ARTIFACT,
      bootstrapWorker: async () => HANDSHAKE,
      resolveSshIdentity: async () => ({ kind: "path", path: "/keys/worker" }),
      applyTranscriptCommit: async (params) => {
        const gate = this.transcriptGate;
        if (gate?.phase === "before-apply") {
          gate.entered.resolve();
          await gate.release.promise;
        }
        const result = await committer.commit(params);
        if (gate?.phase === "after-apply") {
          gate.entered.resolve();
          await gate.release.promise;
        }
        return result;
      },
      liveEvents: this.liveEventsValue,
      executeInference,
      inferenceStore: createWorkerInferenceStore({ database: this.database }),
    });
  }

  private accept(socket: WebSocket): void {
    this.connectionCount += 1;
    this.sockets.add(socket);
    const connId = `fault-connection-${this.connectionCount}`;
    let client: GatewayWsClient | null = null;
    let closed = false;
    const observe = (data: RawData) => {
      const parsed = JSON.parse(rawDataToString(data)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
      if (typeof request.id !== "string" || typeof request.method !== "string") {
        return;
      }
      this.requestMethods.set(request.id, request.method);
      this.requests.push({ method: request.method, params: structuredClone(request.params) });
    };
    socket.on("message", observe);
    const cleanup = attachWorkerWsMessageHandler({
      socket,
      connId,
      service: this.serviceValue as WorkerConnectionService,
      send: (frame) => this.send(socket, frame),
      close: (code = 1000, reason = "") => socket.close(code, reason),
      isClosed: () => closed || socket.readyState === WebSocket.CLOSED,
      clearHandshakeTimer: () => {},
      getClient: () => client,
      setClient: (next) => {
        client = next;
        if (next.worker) {
          this.admissions.push(next.worker);
        }
        return true;
      },
      setHandshakeState: () => {},
      advanceHandshakePhase: () => {},
      setCloseCause: () => {},
      setLastFrameMeta: () => {},
      logGateway: { warn: () => {} },
      logWsControl: { warn: () => {} },
    });
    this.socketCleanups.add(cleanup);
    socket.on("close", () => {
      closed = true;
      socket.off("message", observe);
      cleanup();
      this.socketCleanups.delete(cleanup);
      this.sockets.delete(socket);
    });
  }

  private send(socket: WebSocket, frame: unknown): void {
    const response =
      frame && typeof frame === "object" && !Array.isArray(frame)
        ? (frame as { event?: unknown; id?: unknown; payload?: { seq?: unknown } })
        : undefined;
    const method =
      typeof response?.id === "string" ? this.requestMethods.get(response.id) : undefined;
    const faultIndex = this.faults.findIndex((fault) => {
      if (fault.kind === "drop-response") {
        return method === fault.method;
      }
      return response?.event === "worker.inference.event" && response.payload?.seq === fault.seq;
    });
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0] : undefined;
    if (fault?.kind === "drop-response") {
      if (fault.restart) {
        this.hardRestart({ corroborateLiveOwner: false });
      } else {
        socket.terminate();
      }
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const encoded = JSON.stringify(frame);
    if (fault?.kind === "partition-after-inference-event") {
      socket.send(encoded, () => socket.terminate());
      return;
    }
    socket.send(encoded);
  }

  private terminateSockets(): void {
    for (const socket of this.sockets) {
      socket.terminate();
    }
  }
}

async function stopClients(clients: WorkerClients | undefined): Promise<void> {
  if (!clients) {
    return;
  }
  clients.inference.dispose();
  clients.live.dispose();
  await clients.connection.stop();
}

describe("cloud worker milestone 2 fault injection", () => {
  let harness: ComposedGatewayHarness;
  const clients: WorkerClients[] = [];

  beforeEach(async () => {
    harness = await ComposedGatewayHarness.create();
    await harness.start();
  });

  afterEach(async () => {
    for (const current of clients.splice(0)) {
      await stopClients(current);
    }
    await harness.close();
  });

  it("survives repeated tunnel partitions without transcript duplication, live replay, or rebilling", async () => {
    const current = harness.createClients();
    clients.push(current);
    const firstRelease = createDeferred();
    const secondRelease = createDeferred();
    const started = createDeferred();
    harness.providerPlan = {
      kind: "partitioned",
      firstRelease,
      secondRelease,
      started,
      text: "partitioned reply",
    };
    harness.addFault({ kind: "partition-after-inference-event", seq: 1 });
    harness.addFault({ kind: "partition-after-inference-event", seq: 2 });
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: false });
    harness.addFault({ kind: "drop-response", method: "worker.live-event", restart: false });
    await current.connection.start();

    const inferenceSeqs: number[] = [];
    const inference = current.inference.start(inferenceRequest(harness.epoch, "partitioned-turn"), {
      onEvent: (event) => inferenceSeqs.push(event.seq),
    });
    await started.promise;
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(2));
    firstRelease.resolve();
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(3));
    secondRelease.resolve();
    await expect(inference).resolves.toEqual(doneOutcome("partitioned reply"));

    const committed = await current.transcript.commit([
      transcriptMessage("partitioned user"),
      { ...doneMessage("partitioned reply"), timestamp: 2 },
    ]);
    const live = ["one", "two", "three"].map((delta) =>
      current.live.emit(RUN_ID, {
        kind: "assistant",
        payload: { text: delta, delta },
      }),
    );
    await expect(Promise.all(live)).resolves.toHaveLength(3);

    const transcriptRequests = harness.requestParams("worker.transcript.commit");
    expect(transcriptRequests).toHaveLength(2);
    expect(transcriptRequests[1]).toEqual(transcriptRequests[0]);
    expect(harness.requestParams("worker.inference.start")).toHaveLength(3);
    expect(harness.providerCalls).toBe(1);
    expect(inferenceSeqs).toEqual([1, 2]);
    expect(harness.liveDeltas).toEqual(["one", "two", "three"]);
    expect(
      harness
        .requestParams("worker.live-event")
        .map((request) => (request as WorkerLiveEventParams).seq),
    ).toEqual([1, 1, 2, 3]);
    const transcript = SessionManager.open(harness.sessionFile).getEntries();
    expect(transcript).toHaveLength(2);
    expect(new Set(transcript.map((entry) => entry.id)).size).toBe(2);
    expect(SessionManager.open(harness.sessionFile).getLeafId()).toBe(committed.newLeafId);
  });

  it("recovers durable state across gateway restart and renumbers a lost live window", async () => {
    const current = harness.createClients();
    clients.push(current);
    const providerRelease = createDeferred<WorkerInferenceTerminalOutcome>();
    const providerStarted = createDeferred();
    const commitEntered = createDeferred();
    const commitRelease = createDeferred();
    harness.providerPlan = { kind: "pending", release: providerRelease, started: providerStarted };
    harness.transcriptGate = {
      phase: "after-apply",
      entered: commitEntered,
      release: commitRelease,
    };
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: true });
    await current.connection.start();

    await current.live.emit(RUN_ID, {
      kind: "assistant",
      payload: { text: "acked", delta: "acked" },
    });
    const inference = current.inference.start(inferenceRequest(harness.epoch, "restart-turn"));
    await providerStarted.promise;
    const commit = current.transcript.commit([transcriptMessage("restart transcript")]);
    await commitEntered.promise;
    const liveTail = ["tail-a", "tail-b"].map((delta) =>
      current.live.emit(RUN_ID, {
        kind: "assistant",
        payload: { text: delta, delta },
      }),
    );
    // The restart fault fires when the gated commit response drains; make sure the
    // pre-restart tail-a live request reached the gateway first or the lost-window
    // replay assertion below becomes timing-dependent.
    await vi.waitFor(() => expect(harness.requestParams("worker.live-event")).toHaveLength(2));
    commitRelease.resolve();

    await expect(commit).resolves.toMatchObject({ entryIds: [expect.any(String)] });
    await expect(inference).resolves.toMatchObject({ type: "error", reason: "provider-error" });
    await expect(Promise.all(liveTail)).resolves.toHaveLength(2);
    expect(harness.providerCalls).toBe(1);
    expect(harness.replacementProviderCalls).toBe(0);
    expect(harness.admissions.at(-1)).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: harness.epoch,
      sessionId: SESSION_ID,
    });
    expect(harness.liveDeltas).toEqual(["acked", "tail-a", "tail-b"]);
    const liveRequests = harness.requestParams("worker.live-event").map((request) => {
      const live = request as WorkerLiveEventParams;
      return [live.seq, live.lastAckedSeq];
    });
    // Pre-restart prefix is deterministic (the waitFor above pins tail-a's send).
    expect(liveRequests.slice(0, 2)).toEqual([
      [1, 0],
      [2, 1],
    ]);
    // Whether tail-a's ack beats the socket teardown is a legitimate race, so the
    // exact retry trace varies; what must hold is that the cleared window forced a
    // resync replay renumbered from the fresh ack state.
    expect(liveRequests.length).toBeGreaterThanOrEqual(4);
    expect(liveRequests.slice(2)).toContainEqual([1, 0]);
    expect(SessionManager.open(harness.sessionFile).getEntries()).toHaveLength(1);
    providerRelease.resolve(doneOutcome("late stale provider result"));
  });

  it("fences a dead worker and admits a fresh owner at a higher epoch", async () => {
    const old = harness.createClients();
    clients.push(old);
    await old.connection.start();
    const oldCommit = await old.transcript.commit([transcriptMessage("old owner")]);
    const pendingRelease = createDeferred<WorkerInferenceTerminalOutcome>();
    const pendingStarted = createDeferred();
    harness.providerPlan = { kind: "pending", release: pendingRelease, started: pendingStarted };
    const oldInference = old.inference.start(inferenceRequest(harness.epoch, "handoff-old"));
    const oldInferenceRejected = expect(oldInference).rejects.toBeInstanceOf(WorkerFencedError);
    await pendingStarted.promise;

    const oldEpoch = harness.epoch;
    const newEpoch = harness.reclaimWithCredential(REPLACEMENT_CREDENTIAL);
    expect(newEpoch).toBeGreaterThan(oldEpoch);
    const rejected = old.transcript.commit([transcriptMessage("late old owner")]);
    await expect(rejected).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      reason: "credential-replaced",
    });
    await expect(old.connection.waitForExit()).resolves.toMatchObject({ kind: "fenced" });
    pendingRelease.resolve(doneOutcome("stale paid output"));
    await oldInferenceRejected;

    harness.providerPlan = { kind: "immediate", text: "new owner reply" };
    // Milestone-3 admission binds the worker to a single run; the fresh owner
    // must be admitted for the run it executes.
    const fresh = harness.createClients({
      admissionProof: REPLACEMENT_CREDENTIAL,
      epoch: newEpoch,
      baseLeafId: oldCommit.newLeafId,
      runId: "fresh-run",
    });
    clients.push(fresh);
    await fresh.connection.start();
    await expect(
      fresh.inference.start({
        ...inferenceRequest(newEpoch, "handoff-new"),
        runId: "fresh-run",
      }),
    ).resolves.toEqual(doneOutcome("new owner reply"));
    await fresh.transcript.commit([transcriptMessage("new owner")]);

    const messages = SessionManager.open(harness.sessionFile)
      .getEntries()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(harness.providerCalls).toBe(2);
    expect(
      harness.database.db
        .prepare(
          "SELECT run_epoch, next_seq FROM worker_transcript_commit_heads WHERE session_id = ? ORDER BY run_epoch",
        )
        .all(SESSION_ID),
    ).toEqual([
      { run_epoch: oldEpoch, next_seq: 2 },
      { run_epoch: newEpoch, next_seq: 2 },
    ]);
  });

  it("fail-stops a reconnected commit whose base changes while application is in flight", async () => {
    const current = harness.createClients();
    clients.push(current);
    const entered = createDeferred();
    const release = createDeferred();
    harness.transcriptGate = { phase: "before-apply", entered, release };
    await current.connection.start();
    const commit = current.transcript.commit([transcriptMessage("stale paid output")]);
    await entered.promise;
    harness.partition();
    const local = SessionManager.open(harness.sessionFile);
    local.appendMessage(transcriptMessage("competing local entry"));
    release.resolve();

    await expect(commit).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      reason: "stale-base-leaf",
    });
    await expect(
      current.transcript.commit([transcriptMessage("must not retry after stale")]),
    ).rejects.toMatchObject({ name: "WorkerTranscriptCommitError" });
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(2);
    expect(SessionManager.open(harness.sessionFile).getEntries()).toHaveLength(1);
  });

  it("advances a worker live stream whose run context is dispatch-owned and visible", async () => {
    const current = harness.createClients();
    clients.push(current);
    // A visible turn's run context is claimed by the gateway dispatch before the
    // turn hands off to the worker. The worker's first live event must adopt that
    // dispatch-owned context (seq advances from 1) and keep the run visible.
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(RUN_ID, {
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      isControlUiVisible: true,
      lifecycleGeneration,
    });
    try {
      await current.connection.start();

      await expect(
        Promise.all(
          ["one", "two"].map((delta) =>
            current.live.emit(RUN_ID, { kind: "assistant", payload: { text: delta, delta } }),
          ),
        ),
      ).resolves.toHaveLength(2);

      expect(harness.liveDeltas).toEqual(["one", "two"]);
      expect(
        harness
          .requestParams("worker.live-event")
          .map((request) => (request as WorkerLiveEventParams).seq),
      ).toEqual([1, 2]);
      expect(getAgentRunContext(RUN_ID)?.isControlUiVisible).toBe(true);
    } finally {
      clearAgentRunContext(RUN_ID);
    }
  });

  it("settles stop during an in-flight commit without retrying or spinning", async () => {
    const current = harness.createClients();
    clients.push(current);
    const entered = createDeferred();
    const release = createDeferred();
    harness.transcriptGate = { phase: "before-apply", entered, release };
    await current.connection.start();
    const commit = current.transcript.commit([transcriptMessage("stopped commit")]);
    await entered.promise;

    await current.connection.stop();
    await expect(commit).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
    release.resolve();
  });
});
