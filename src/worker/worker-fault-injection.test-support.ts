import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  type WorkerLiveEventParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceTerminalOutcome } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerServer from "../gateway/server/ws-connection/worker-connection.js";
import type { GatewayWsClient } from "../gateway/server/ws-types.js";
import type { WorkerConnectionIdentity } from "../gateway/worker-environments/connection-identity.js";
import { hashWorkerCredential } from "../gateway/worker-environments/credential.js";
import { createWorkerInferenceStore } from "../gateway/worker-environments/inference-store.js";
import { createWorkerChatProjection } from "../gateway/worker-environments/live-chat.test-support.js";
import * as liveEvents from "../gateway/worker-environments/live-events.js";
import { projectWorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import * as placements from "../gateway/worker-environments/placement-store.js";
import {
  createWorkerSessionPlacementGate,
  type WorkerSessionPlacementGate,
} from "../gateway/worker-environments/placement-worker-gate.js";
import * as workerEnv from "../gateway/worker-environments/service.js";
import * as envStore from "../gateway/worker-environments/store.js";
import { createWorkerTranscriptCommitStore } from "../gateway/worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "../gateway/worker-environments/transcript-commit.js";
import { onAgentRuntimeEvent } from "../infra/agent-events.js";
import type { WorkerProvider, WorkerSshEndpoint } from "../plugins/types.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerConnection, type WorkerConnection } from "./worker-connection.js";
import { WorkerFaultPlacementLifecycle } from "./worker-fault-placement-lifecycle.test-support.js";
import * as workerRpc from "./worker-rpc-clients.js";

export const SESSION_ID = "fault-session";
export const SESSION_KEY = "agent:main:fault-session";
export const ENVIRONMENT_ID = "fault-environment";
export const RUN_ID = "fault-run";
const BUNDLE_HASH = Array.from({ length: 64 }, () => "a").join("");
const CREDENTIAL = ["worker", "fault", "fixture"].join("-");
const MODEL_REF = { provider: "fake", model: "fault-model" } as const;
const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  hostKey: [["ssh", "ed25519"].join("-"), "AAAA"].join(" "),
  keyRef: { source: "file", provider: "worker-fixtures", id: "/development-key" },
};
const HANDSHAKE = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "fault-test",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
const BUNDLE_ARTIFACT = {
  install: "bundle" as const,
  bundleHash: BUNDLE_HASH,
  openclawVersion: HANDSHAKE.openclawVersion,
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
  tarballBytes: 1,
  tarballSha256: Array.from({ length: 64 }, () => "b").join(""),
  tarballPath: "/gateway/cache/worker-bundle.tgz",
};
const PROVIDER: WorkerProvider = {
  id: "fake",
  resolveAllocation: async () => ({ leaseId: "lease-fault", sharedHost: false }),
  provision: async () => ({ leaseId: "lease-fault", ssh: SSH_ENDPOINT }),
  inspect: async () => ({ status: "active" }),
  destroy: async () => {},
};

type Deferred<T> = ReturnType<typeof createDeferred<T>>;

type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

export function doneMessage(text: string): WorkerDoneMessage {
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

export const doneOutcome = (text: string): WorkerInferenceTerminalOutcome => ({
  type: "done",
  message: doneMessage(text),
});

type FaultRule =
  | { kind: "drop-response"; method: string; restart: boolean }
  | { kind: "partition-after-inference-event"; seq: number };

type TranscriptGate = {
  phase: "before-apply" | "after-apply";
  entered: Deferred<void>;
  release: Deferred<void>;
};

type LiveEventGate = {
  stage: "before-service" | "after-service";
  target: "preview" | "finishing";
  entered: Deferred<void>;
  release: Deferred<void>;
  claimed: boolean;
};

type ProviderPlan =
  | { kind: "immediate"; text: string; outcome?: WorkerInferenceTerminalOutcome }
  | {
      kind: "live-preview";
      nextRelease: Deferred<void>;
      produced: Deferred<void>;
      text: string;
    }
  | {
      kind: "partitioned";
      firstRelease: Deferred<void>;
      secondRelease: Deferred<void>;
      started: Deferred<void>;
      text: string;
    }
  | { kind: "pending"; release: Deferred<WorkerInferenceTerminalOutcome>; started: Deferred<void> };

export type WorkerClients = {
  connection: WorkerConnection;
  transcript: workerRpc.WorkerTranscriptCommitClient;
  live: workerRpc.WorkerLiveEventClient;
  inference: workerRpc.WorkerInferenceProxyClient;
};

type WorkerClientOptions = {
  admissionProof?: string;
  epoch?: number;
  baseLeafId?: string | null;
  initialSeq?: number;
  initialAckedSeq?: number;
  runId?: string;
};

export class ComposedGatewayHarness {
  readonly socketPath: string;
  readonly cfg: OpenClawConfig;
  readonly database: stateDb.OpenClawStateDatabase;
  readonly store: envStore.WorkerEnvironmentStore;
  readonly placementStore: placements.WorkerSessionPlacementStore;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly admissions: WorkerConnectionIdentity[] = [];
  readonly liveDeltas: string[] = [];
  readonly chat: ReturnType<typeof createWorkerChatProjection>;
  readonly abandonedServices: workerEnv.WorkerEnvironmentService[] = [];
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
  private readonly liveEventGates: LiveEventGate[] = [];
  private serviceValue!: workerEnv.WorkerEnvironmentService;
  private liveEventsValue!: liveEvents.WorkerLiveEventReceiver;
  private readonly placementLifecycle: WorkerFaultPlacementLifecycle;
  private placementGateValue: WorkerSessionPlacementGate | undefined;
  private useReplacementExecutor = false;
  private unsubscribeLive: (() => void) | undefined;

  static async create(root: string): Promise<ComposedGatewayHarness> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      { sessionId: SESSION_ID, updatedAt: 1 },
    );
    const sessionTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    return new ComposedGatewayHarness(root, sessionTarget);
  }

  private constructor(
    readonly root: string,
    readonly sessionTarget: Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>>,
  ) {
    const stateDir = path.join(root, "state");
    this.socketPath = path.join(root, "gateway.sock");
    this.cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      cloudWorkers: {
        profiles: { development: { provider: "fake", settings: { region: "test" } } },
      },
    };
    this.database = stateDb.openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    this.store = envStore.createWorkerEnvironmentStore({ database: this.database });
    this.placementStore = placements.createWorkerSessionPlacementStore({
      database: this.database,
    });
    this.seedAttachedEnvironment();
    this.liveEventsValue = this.createLiveEvents(true);
    this.placementLifecycle = new WorkerFaultPlacementLifecycle({
      agentId: "main",
      bundleHash: BUNDLE_HASH,
      environmentId: ENVIRONMENT_ID,
      environmentStore: this.store,
      getLiveEvents: () => this.liveEventsValue,
      getOwnerEpoch: () => this.epoch,
      placementStore: this.placementStore,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    this.placementGateValue = this.createPlacementGate();
    this.serviceValue = this.createService();
    this.httpServer = createServer();
    this.webSocketServer = new WebSocketServer({ server: this.httpServer });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));
    this.chat = createWorkerChatProjection(SESSION_KEY);
    this.unsubscribeLive = onAgentRuntimeEvent((event) => {
      if (typeof event.data.delta === "string") {
        this.liveDeltas.push(event.data.delta);
      }
    });
  }

  get epoch(): number {
    const record = this.store.get(ENVIRONMENT_ID);
    if (!record) {
      throw new Error("fault environment missing");
    }
    return record.ownerEpoch;
  }

  async start(): Promise<void> {
    // ws forwards bind errors first; wait there so failed binds reject setup.
    const listening = once(this.webSocketServer, "listening");
    this.httpServer.listen(this.socketPath);
    await listening;
  }

  addFault(rule: FaultRule): void {
    this.faults.push(rule);
  }

  addLiveEventGate(stage: LiveEventGate["stage"], target: LiveEventGate["target"]): LiveEventGate {
    const gate = {
      stage,
      target,
      entered: createDeferred(),
      release: createDeferred(),
      claimed: false,
    };
    this.liveEventGates.push(gate);
    return gate;
  }

  settleRun(runId: string): void {
    this.placementLifecycle.settleRun(runId);
  }

  createDescriptor(params: WorkerClientOptions = {}): WorkerLaunchDescriptor {
    const epoch = params.epoch ?? this.epoch;
    const credential = params.admissionProof ?? CREDENTIAL;
    const runId = params.runId ?? RUN_ID;
    const claim = this.placementLifecycle.prepareRun(runId, credential);
    if (claim.owner.ownerEpoch !== epoch) {
      throw new Error("fault descriptor epoch does not match its exact placement claim");
    }
    return {
      version: 4,
      connectionEndpoint: { kind: "unix", socketPath: this.socketPath },
      admission: {
        environmentId: ENVIRONMENT_ID,
        credential,
        sessionId: SESSION_ID,
        ownerEpoch: epoch,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: HANDSHAKE,
      },
      assignment: {
        agentId: "worker-agent",
        runId,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        agentRuntimeIdentityToken: "test-agent-runtime-token",
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
        toolAuthority: {
          allowedToolNames: ["read", "write", "edit", "apply_patch", "exec", "process"],
        },
      },
    };
  }

  createClients(params: WorkerClientOptions = {}): WorkerClients {
    const descriptor = this.createDescriptor(params);
    const epoch = descriptor.admission.ownerEpoch;
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: this.socketPath },
      connectParams: buildWorkerConnectParams(descriptor),
      admissionTimeoutMs: 1_000,
      admissionDeadlineMs: 5_000,
      requestTimeoutMs: 2_000,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    return {
      connection,
      transcript: new workerRpc.WorkerTranscriptCommitClient(connection, {
        runEpoch: epoch,
        baseLeafId: params.baseLeafId ?? null,
        initialSeq: params.initialSeq ?? 1,
      }),
      live: new workerRpc.WorkerLiveEventClient(connection, {
        runEpoch: epoch,
        initialAckedSeq: params.initialAckedSeq ?? 0,
      }),
      inference: new workerRpc.WorkerInferenceProxyClient(connection),
    };
  }

  hardRestart(): void {
    this.chat.state.clear();
    this.abandonedServices.push(this.serviceValue);
    this.liveEventsValue.clear();
    this.liveEventsValue = this.createLiveEvents(false);
    this.placementGateValue = this.createPlacementGate({ rejectExistingWorkerClaims: true });
    this.useReplacementExecutor = true;
    this.serviceValue = this.createService();
    this.terminateSockets();
  }

  partition(): void {
    this.terminateSockets();
  }

  reclaimWithCredential(credential: string, runId: string): number {
    const placement = this.placementStore.get(SESSION_ID);
    const staleClaim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
    if (
      !placement ||
      placement.state !== "active" ||
      !staleClaim ||
      staleClaim.owner.kind !== "worker"
    ) {
      throw new Error("fault placement has no active worker claim to reclaim");
    }
    this.settleRun(staleClaim.runId);
    this.placementLifecycle.reclaimPlacement(placement, staleClaim.owner.ownerEpoch);
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
    this.placementLifecycle.prepareRun(runId, credential);
    return next.ownerEpoch;
  }

  requestParams(method: string): unknown[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => structuredClone(request.params));
  }

  async close(): Promise<void> {
    this.transcriptGate?.release.resolve();
    for (const gate of this.liveEventGates) {
      gate.release.resolve();
    }
    if (this.providerPlan.kind === "live-preview") {
      this.providerPlan.nextRelease.resolve();
    } else if (this.providerPlan.kind === "partitioned") {
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
    this.chat.dispose();
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
    stateDb.closeOpenClawStateDatabaseForTest();
    await fs.rm(this.root, { recursive: true, force: true });
  }

  private seedAttachedEnvironment(): void {
    let environment = this.store.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:fault-environment",
    });
    const transitions = [
      { to: "provisioning", patch: {} },
      { to: "bootstrapping", patch: { leaseId: "lease-fault", sshEndpoint: SSH_ENDPOINT } },
      {
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
      },
      {
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
      },
    ] as const;
    for (const transition of transitions) {
      environment = this.store.transition({
        environmentId: ENVIRONMENT_ID,
        from: environment.state,
        ...transition,
      });
    }
  }

  private createLiveEvents(corroborateOwner: boolean): liveEvents.WorkerLiveEventReceiver {
    const binding = {
      environmentId: ENVIRONMENT_ID,
      runEpoch: this.epoch,
      sessionId: SESSION_ID,
    };
    const receiver = liveEvents.createWorkerLiveEventReceiver({
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

  private createService(): workerEnv.WorkerEnvironmentService {
    const ledger = createWorkerTranscriptCommitStore({ database: this.database });
    const committer = createWorkerTranscriptCommitter({
      getConfig: () => this.cfg,
      store: ledger,
    });
    const executeInference: Parameters<
      typeof workerEnv.createWorkerEnvironmentService
    >[0]["executeInference"] = async (params) => {
      if (this.useReplacementExecutor) {
        this.replacementProviderCalls += 1;
      } else {
        this.providerCalls += 1;
      }
      const plan = this.providerPlan;
      if (plan.kind === "immediate") {
        return structuredClone(plan.outcome ?? doneOutcome(plan.text));
      }
      if (plan.kind === "pending") {
        plan.started.resolve();
        return await plan.release.promise;
      }
      if (plan.kind === "live-preview") {
        params.emit({
          type: "start",
          resolvedModel: { api: "openai-responses", ...MODEL_REF },
          timestamp: Date.now(),
        });
        params.emit({ type: "text_start", contentIndex: 0 });
        params.emit({ type: "text_delta", contentIndex: 0, delta: "preview " });
        await plan.nextRelease.promise;
        params.emit({ type: "text_delta", contentIndex: 0, delta: "reply" });
        params.emit({ type: "text_end", contentIndex: 0 });
        plan.produced.resolve();
        return doneOutcome(plan.text);
      }
      plan.started.resolve();
      params.emit({ type: "text_delta", contentIndex: 0, delta: "first" });
      await plan.firstRelease.promise;
      params.emit({ type: "text_delta", contentIndex: 0, delta: "second" });
      await plan.secondRelease.promise;
      return doneOutcome(plan.text);
    };
    return workerEnv.createWorkerEnvironmentService({
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
      ...(this.placementGateValue ? { placementStore: this.placementGateValue } : {}),
    });
  }

  private createPlacementGate(
    options: { rejectExistingWorkerClaims?: boolean } = {},
  ): WorkerSessionPlacementGate {
    return createWorkerSessionPlacementGate(this.placementStore, options);
  }

  private matchesLiveEventGate(gate: LiveEventGate, request: WorkerLiveEventParams): boolean {
    if (gate.target === "preview") {
      return request.event.kind === "assistant" || request.event.kind === "thinking";
    }
    return request.event.kind === "lifecycle" && request.event.payload.phase === "finishing";
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
    const service = this.serviceValue;
    const cleanup = workerServer.attachWorkerWsMessageHandler({
      socket,
      connId,
      service: {
        ...service,
        pushLiveEvent: async (identity, request) => {
          const gate = this.liveEventGates.find(
            (candidate) => !candidate.claimed && this.matchesLiveEventGate(candidate, request),
          );
          if (gate) {
            gate.claimed = true;
            if (gate.stage === "before-service") {
              gate.entered.resolve();
              await gate.release.promise;
            }
          }
          const result = await service.pushLiveEvent(identity, request);
          if (gate?.stage === "after-service") {
            gate.entered.resolve();
            await gate.release.promise;
          }
          return result;
        },
      } as workerServer.WorkerConnectionService,
      publicAdmission: { clientIp: "127.0.0.1", rateLimiter: undefined },
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
        this.hardRestart();
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
