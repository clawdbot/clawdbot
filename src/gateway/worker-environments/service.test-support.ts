import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProvider,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentStore,
  type WorkerEnvironmentTransitionPatch,
} from "./store.js";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
export type WorkerEnvironmentServiceOptions = Parameters<typeof createWorkerEnvironmentService>[0];
export type WorkerEnvironmentServiceError = Error & { code: string };
export const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
};
export const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/var/lib/crabbox/vnc.password",
  apps: [
    {
      id: "browser",
      executablePath: "/usr/local/bin/openclaw-worker-browser",
      cdpPort: 9222,
    },
    { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
  ],
};
export const BUNDLE_HASH = "a".repeat(64);
export const BUNDLE_ARTIFACT: WorkerInstallationArtifact = {
  install: "bundle",
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  protocolFeatures: [],
  tarballBytes: 1,
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/cache/worker-bundle.tgz",
};
export const NPM_ARTIFACT: WorkerInstallationArtifact = {
  install: "npm",
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  packageIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  protocolFeatures: [],
  packageSpec: "openclaw@2026.7.2",
};
export const BOOTSTRAP_RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  protocolFeatures: [],
};
export const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const LIVE_EVENT_ACK = { ok: true as const, result: { ackedSeq: 1 } };
export const LIVE_EVENT = {
  runEpoch: 1,
  lastAckedSeq: 0,
  seq: 1,
  runId: "run-1",
  event: { kind: "assistant" as const, payload: { text: "hi", delta: "hi" } },
};

export type WorkerLifecycleLease = Parameters<WorkerProvider["inspect"]>[0];
type TranscriptRequest = Parameters<WorkerEnvironmentService["commitTranscript"]>[1];
type TranscriptOverrides = Partial<Pick<TranscriptRequest, "baseLeafId" | "runEpoch" | "seq">>;
type LiveEventRequest = Parameters<WorkerEnvironmentService["pushLiveEvent"]>[1];
type LiveOpts = Partial<Pick<LiveEventRequest, "lastAckedSeq" | "runEpoch" | "runId" | "seq">>;

export const testState = {} as {
  root: string;
  stateDb: OpenClawStateDatabase;
  store: WorkerEnvironmentStore;
  service: WorkerEnvironmentService | undefined;
  config: OpenClawConfig;
  nowMs: number;
  providersEnabled: boolean;
  prepareInstallation: WorkerEnvironmentServiceOptions["prepareInstallation"];
  bootstrapWorker: WorkerEnvironmentServiceOptions["bootstrapWorker"];
};

export function setupWorkerEnvironmentServiceSuite() {
  beforeEach(async () => {
    testState.root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-service-"),
    );
    testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: testState.root },
    });
    testState.nowMs = 1_000;
    testState.providersEnabled = true;
    testState.store = createWorkerEnvironmentStore({
      database: testState.stateDb,
      now: () => testState.nowMs,
    });
    testState.config = {
      cloudWorkers: {
        desktop: true,
        profiles: {
          development: {
            provider: "fake",
            settings: { region: "test" },
          },
        },
      },
    };
    testState.prepareInstallation = vi.fn(async (install) =>
      install === "bundle" ? BUNDLE_ARTIFACT : NPM_ARTIFACT,
    );
    testState.bootstrapWorker = vi.fn(async ({ installation }) => ({
      bundleHash: installation.bundleHash,
      openclawVersion: installation.openclawVersion,
      protocolFeatures: [...installation.protocolFeatures],
    }));
  });

  afterEach(async () => {
    await testState.service?.stop();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(testState.root, { recursive: true, force: true });
  });
}

export function getDevelopmentProfile() {
  return expectDefined(
    testState.config.cloudWorkers?.profiles?.development,
    "development worker profile",
  );
}

export function createService(
  provider: WorkerProvider,
  serviceOptions: Partial<
    Pick<
      WorkerEnvironmentServiceOptions,
      | "applyTranscriptCommit"
      | "bootstrapCallTimeoutMs"
      | "executeInference"
      | "executeSessionTool"
      | "providerCallTimeoutMs"
      | "resolveSshIdentity"
      | "ensureNodeWorkerBundle"
      | "prepareNodeEnrollment"
      | "retireNodeEnrollment"
      | "stopNodeEnrollmentWaits"
      | "tunnelManager"
      | "generateWorkerCredential"
      | "liveEvents"
      | "now"
      | "nodeTunnelManager"
      | "nodeDesktopCarrier"
      | "placementStore"
      | "workerCredentialTtlMs"
    >
  > = {},
) {
  testState.service = createWorkerEnvironmentService({
    store: testState.store,
    getConfig: () => testState.config,
    resolveProvider: (providerId) =>
      testState.providersEnabled && providerId === provider.id ? provider : undefined,
    prepareInstallation: testState.prepareInstallation,
    bootstrapWorker: testState.bootstrapWorker,
    resolveSshIdentity: async () => ({ kind: "path", path: "/keys/worker" }),
    generateWorkerCredential: () => CREDENTIAL,
    executeInference: async () => ({
      type: "error",
      reason: "cancelled",
      message: "Inference cancelled",
    }),
    inferenceStore: createWorkerInferenceStore({
      database: testState.stateDb,
      now: () => testState.nowMs,
    }),
    now: () => testState.nowMs,
    reconcileIntervalMs: 25,
    ...serviceOptions,
  });
  return testState.service;
}

export function createProvider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    id: "fake",
    supportedExecutionModes: ["remote-exec"],
    provision: async () => ({ leaseId: "lease-1", ssh: SSH_ENDPOINT }),
    inspect: async () => ({ status: "active" }),
    destroy: async () => {},
    ...overrides,
  };
}

export function createLiveEvents(overrides: Record<string, unknown> = {}) {
  return {
    apply: vi.fn(() => LIVE_EVENT_ACK),
    bindSession: vi.fn(() => true),
    clear: vi.fn(),
    clearEnvironment: vi.fn(),
    rotateCredential: vi.fn(() => true),
    start: vi.fn(),
    ...overrides,
  };
}

export function seedBootstrapping(
  environmentId: string,
  install?: WorkerInstallationArtifact["install"],
  sharedHost = false,
) {
  const intent = testState.store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { ...(install ? { install } : {}), settings: { region: "test" } },
    provisionOperationId: `provision:${environmentId}`,
  });
  const provisioning = testState.store.transition({
    environmentId,
    from: intent.state,
    to: "provisioning",
  });
  return testState.store.transition({
    environmentId,
    from: provisioning.state,
    to: "bootstrapping",
    patch: { leaseId: `lease:${environmentId}`, sshEndpoint: SSH_ENDPOINT, sharedHost },
  });
}

export function seedReady(
  environmentId: string,
  install?: WorkerInstallationArtifact["install"],
  sharedHost = false,
) {
  const bootstrapping = seedBootstrapping(environmentId, install, sharedHost);
  return testState.store.transition({
    environmentId,
    from: bootstrapping.state,
    to: "ready",
    patch: readyPatch(environmentId),
  });
}

export function seedReadyDesktop(environmentId: string, desktop: WorkerDesktopEndpoint = DESKTOP) {
  const intent = testState.store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test", desktop: true } },
    provisionOperationId: `provision:${environmentId}`,
  });
  const provisioning = testState.store.transition({
    environmentId,
    from: intent.state,
    to: "provisioning",
  });
  const bootstrapping = testState.store.transition({
    environmentId,
    from: provisioning.state,
    to: "bootstrapping",
    patch: {
      leaseId: `lease:${environmentId}`,
      sshEndpoint: SSH_ENDPOINT,
      desktop,
    },
  });
  return testState.store.transition({
    environmentId,
    from: bootstrapping.state,
    to: "ready",
    patch: readyPatch(environmentId),
  });
}

export function seedReadyNodeDesktop(
  environmentId: string,
  desktop: WorkerDesktopEndpoint = DESKTOP,
) {
  const intent = testState.store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test", desktop: true } },
    provisionOperationId: `provision:${environmentId}`,
  });
  const provisioning = testState.store.transition({
    environmentId,
    from: intent.state,
    to: "provisioning",
  });
  return testState.store.transition({
    environmentId,
    from: provisioning.state,
    to: "ready",
    patch: {
      leaseId: `lease:${environmentId}`,
      nodeDeviceId: `node:${environmentId}`,
      sshEndpoint: null,
      desktop,
      ...readyPatch(environmentId),
    },
  });
}

export function readyPatch(
  environmentId: string,
  receipt: NonNullable<WorkerEnvironmentTransitionPatch["bootstrapReceipt"]> = BOOTSTRAP_RECEIPT,
) {
  return {
    bootstrapReceipt: receipt,
    credential: {
      credentialHash: hashWorkerCredential([CREDENTIAL, environmentId].join("-")),
      sessionId: null,
      rpcSetVersion: 1,
      expiresAtMs: testState.nowMs + 10_000,
    },
  };
}

export function attachedPatch(environmentId: string, sessionId: string) {
  return {
    attachedSessionIds: [sessionId],
    credential: {
      credentialHash: hashWorkerCredential([CREDENTIAL, environmentId, sessionId].join("-")),
      sessionId,
      rpcSetVersion: 1,
      expiresAtMs: testState.nowMs + 10_000,
    },
  };
}

export function admissionFor(environmentId: string) {
  return {
    environmentId,
    credential: [CREDENTIAL, environmentId].join("-"),
    sessionId: null,
    runId: null,
    ownerEpoch: 1,
    rpcSetVersion: 1,
    handshake: BOOTSTRAP_RECEIPT,
  };
}

export function seedAttachedIdentity(
  environmentId: string,
  sessionId: string,
): WorkerConnectionIdentity {
  const ready = seedReady(environmentId);
  const attached = testState.store.transition({
    environmentId,
    from: ready.state,
    to: "attached",
    patch: attachedPatch(environmentId, sessionId),
  });
  const credential = testState.store.getCredential(environmentId);
  if (!credential || !attached.bootstrapReceipt) {
    throw new Error("attached worker fixture is incomplete");
  }
  return {
    environmentId,
    credentialHash: credential.credentialHash,
    bundleHash: credential.bundleHash,
    sessionId,
    runId: "run-1",
    turnClaim: {
      sessionId,
      claimId: "claim-run-1",
      runId: "run-1",
      placementGeneration: 1,
      owner: { kind: "worker", environmentId, ownerEpoch: attached.ownerEpoch },
    },
    ownerEpoch: attached.ownerEpoch,
    rpcSetVersion: credential.rpcSetVersion,
    protocolFeatures: [...attached.bootstrapReceipt.protocolFeatures],
    credentialExpiresAtMs: credential.expiresAtMs,
  };
}

export function inferenceRequest(
  identity: WorkerConnectionIdentity,
): Parameters<WorkerEnvironmentService["startInference"]>[1] {
  return {
    runEpoch: identity.ownerEpoch,
    sessionId: identity.sessionId ?? "session-missing",
    runId: identity.runId ?? "run-missing",
    turnId: "turn-inference",
    modelRef: { provider: "fake", model: "model-test" },
    context: { messages: [] },
    options: {},
  };
}

export function transcriptRequest(
  identity: WorkerConnectionIdentity,
  text: string,
  overrides: TranscriptOverrides = {},
): TranscriptRequest {
  return {
    runEpoch: identity.ownerEpoch,
    seq: 1,
    baseLeafId: null,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    ],
    ...overrides,
  };
}

function liveEventRequest(
  identity: WorkerConnectionIdentity,
  event: LiveEventRequest["event"],
  overrides: LiveOpts = {},
): LiveEventRequest {
  return {
    runEpoch: identity.ownerEpoch,
    lastAckedSeq: 0,
    seq: 1,
    runId: identity.runId ?? "run-missing",
    event,
    ...overrides,
  };
}

export function assistantEvent(
  identity: WorkerConnectionIdentity,
  text: string,
  extra: LiveOpts = {},
) {
  return liveEventRequest(identity, { kind: "assistant", payload: { text, delta: text } }, extra);
}

export function terminalEvent(identity: WorkerConnectionIdentity, overrides: LiveOpts = {}) {
  return liveEventRequest(
    identity,
    { kind: "lifecycle", payload: { phase: "end", endedAt: 2 } },
    overrides,
  );
}

export function successfulTranscriptCommit(entryId: string, beforeCommit?: () => Promise<unknown>) {
  return vi.fn(async () => {
    await beforeCommit?.();
    return { ok: true as const, result: { entryIds: [entryId], newLeafId: entryId } };
  });
}

export function sequencedLiveEvents(ackedSeq = (seq: number) => seq) {
  const apply = vi.fn(({ request }: { request: LiveEventRequest }) => ({
    ok: true as const,
    result: { ackedSeq: ackedSeq(request.seq) },
  }));
  return { apply, liveEvents: createLiveEvents({ apply }) };
}

export function placementHarness(
  environmentId: string,
  sessionId: string,
  serviceOptions: Parameters<typeof createService>[1] = {},
) {
  const identity = seedAttachedIdentity(environmentId, sessionId);
  const claim = identity.turnClaim!;
  const credentialHash = hashWorkerCredential(
    [CREDENTIAL, environmentId, sessionId].join("-"),
    claim,
  );
  testState.stateDb.db
    .prepare(
      "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
    )
    .run(credentialHash, environmentId);
  identity.credentialHash = credentialHash;
  const placementStore = {
    readWorkerTurnClaim: vi.fn(() => claim),
    validateWorkerTurn: vi.fn(() => true),
    isWorkerTurnToolAuthorized: vi.fn(() => true),
    updateAckCursors: vi.fn(),
    registerTurnClaimClosedHandler: vi.fn(() => () => {}),
  };
  const workerService = createService(createProvider(), { ...serviceOptions, placementStore });
  return { identity, placementStore, workerService };
}
