import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import {
  WorkerProviderError,
  type WorkerProvider,
  type WorkerSshEndpoint,
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
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
type WorkerEnvironmentServiceOptions = Parameters<typeof createWorkerEnvironmentService>[0];
type WorkerEnvironmentServiceError = Error & { code: string };
const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
};
const BUNDLE_HASH = "a".repeat(64);
const BUNDLE_ARTIFACT: WorkerInstallationArtifact = {
  install: "bundle",
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  protocolFeatures: [],
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/cache/worker-bundle.tgz",
};
const NPM_ARTIFACT: WorkerInstallationArtifact = {
  install: "npm",
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  packageIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  protocolFeatures: [],
  packageSpec: "openclaw@2026.7.2",
};
const BOOTSTRAP_RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.2",
  protocolFeatures: [],
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const LIVE_EVENT_ACK = { ok: true as const, result: { ackedSeq: 1 } };
const LIVE_EVENT = {
  runEpoch: 1,
  lastAckedSeq: 0,
  seq: 1,
  runId: "run-1",
  event: { kind: "assistant" as const, payload: { text: "hi", delta: "hi" } },
};

type WorkerLifecycleLease = Parameters<WorkerProvider["inspect"]>[0];

describe("worker environment service", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let service: WorkerEnvironmentService | undefined;
  let config: OpenClawConfig;
  let nowMs: number;
  let providersEnabled: boolean;
  let prepareInstallation: WorkerEnvironmentServiceOptions["prepareInstallation"];
  let bootstrapWorker: WorkerEnvironmentServiceOptions["bootstrapWorker"];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-service-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    providersEnabled = true;
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    config = {
      cloudWorkers: {
        profiles: {
          development: {
            provider: "fake",
            settings: { region: "test" },
          },
        },
      },
    };
    prepareInstallation = vi.fn(async (install) =>
      install === "bundle" ? BUNDLE_ARTIFACT : NPM_ARTIFACT,
    );
    bootstrapWorker = vi.fn(async ({ installation }) => ({
      bundleHash: installation.bundleHash,
      openclawVersion: installation.openclawVersion,
      protocolFeatures: [...installation.protocolFeatures],
    }));
  });

  afterEach(async () => {
    await service?.stop();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function getDevelopmentProfile() {
    return expectDefined(config.cloudWorkers?.profiles?.development, "development worker profile");
  }

  function createService(
    provider: WorkerProvider,
    serviceOptions: Partial<
      Pick<
        WorkerEnvironmentServiceOptions,
        | "applyTranscriptCommit"
        | "bootstrapCallTimeoutMs"
        | "executeInference"
        | "providerCallTimeoutMs"
        | "resolveSshIdentity"
        | "resolveWorkerGateway"
        | "tunnelManager"
        | "generateWorkerCredential"
        | "liveEvents"
        | "placementStore"
        | "workerCredentialTtlMs"
      >
    > = {},
  ) {
    service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: (providerId) =>
        providersEnabled && providerId === "fake" ? provider : undefined,
      prepareInstallation,
      bootstrapWorker,
      resolveSshIdentity: async () => ({ kind: "path", path: "/keys/worker" }),
      resolveWorkerGateway: () => ({ host: "127.0.0.1", port: 18_789 }),
      generateWorkerCredential: () => CREDENTIAL,
      executeInference: async () => ({
        type: "error",
        reason: "cancelled",
        message: "Inference cancelled",
      }),
      inferenceStore: createWorkerInferenceStore({ database, now: () => nowMs }),
      now: () => nowMs,
      reconcileIntervalMs: 25,
      ...serviceOptions,
    });
    return service;
  }

  function createProvider(
    overrides: Partial<Pick<WorkerProvider, "provision" | "inspect" | "destroy">> = {},
  ): WorkerProvider {
    return {
      id: "fake",
      provision: async () => ({ leaseId: "lease-1", ssh: SSH_ENDPOINT }),
      inspect: async () => ({ status: "active" }),
      destroy: async () => {},
      ...overrides,
    };
  }

  function createLiveEvents(overrides: Record<string, unknown> = {}) {
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

  function seedBootstrapping(
    environmentId: string,
    install?: WorkerInstallationArtifact["install"],
  ) {
    const intent = store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { ...(install ? { install } : {}), settings: { region: "test" } },
      provisionOperationId: `provision:${environmentId}`,
    });
    const provisioning = store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    return store.transition({
      environmentId,
      from: provisioning.state,
      to: "bootstrapping",
      patch: { leaseId: `lease:${environmentId}`, sshEndpoint: SSH_ENDPOINT },
    });
  }

  function seedReady(environmentId: string, install?: WorkerInstallationArtifact["install"]) {
    const bootstrapping = seedBootstrapping(environmentId, install);
    return store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(environmentId),
    });
  }

  function readyPatch(environmentId: string, receipt = BOOTSTRAP_RECEIPT) {
    return {
      bootstrapReceipt: receipt,
      credential: {
        credentialHash: hashWorkerCredential([CREDENTIAL, environmentId].join("-")),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  function attachedPatch(environmentId: string, sessionId: string) {
    return {
      attachedSessionIds: [sessionId],
      credential: {
        credentialHash: hashWorkerCredential([CREDENTIAL, environmentId, sessionId].join("-")),
        sessionId,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  function admissionFor(environmentId: string) {
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

  function seedAttachedIdentity(
    environmentId: string,
    sessionId: string,
  ): WorkerConnectionIdentity {
    const ready = seedReady(environmentId);
    const attached = store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: attachedPatch(environmentId, sessionId),
    });
    const credential = store.getCredential(environmentId);
    if (!credential || !attached.bootstrapReceipt) {
      throw new Error("attached worker fixture is incomplete");
    }
    return {
      environmentId,
      credentialHash: credential.credentialHash,
      bundleHash: credential.bundleHash,
      sessionId,
      runId: "run-1",
      ownerEpoch: attached.ownerEpoch,
      rpcSetVersion: credential.rpcSetVersion,
      protocolFeatures: [...attached.bootstrapReceipt.protocolFeatures],
      credentialExpiresAtMs: credential.expiresAtMs,
    };
  }

  function inferenceRequest(
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

  it("persists intent and an immutable profile snapshot before provisioning", async () => {
    const operationIds: string[] = [];
    const provider = createProvider({
      provision: async (profile, operationId) => {
        operationIds.push(operationId);
        expect(store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            settings: { region: "test" },
          },
        });
        getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
    });

    const workerService = createService(provider);
    const result = await workerService.create("development", "request-1");
    const repeated = await workerService.create("development", "request-1");

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1", ownerEpoch: 1 });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
    expect(store.getCredential(result.environmentId)).toMatchObject({
      credentialHash: hashWorkerCredential(CREDENTIAL),
      ownerEpoch: 1,
      sessionId: null,
    });
    const persistedCredential = database.db
      .prepare("SELECT * FROM worker_environment_credentials WHERE environment_id = ?")
      .get(result.environmentId);
    expect(persistedCredential).toMatchObject({
      credential_hash: hashWorkerCredential(CREDENTIAL),
    });
    expect(JSON.stringify(persistedCredential)).not.toContain(CREDENTIAL);
    const binding = { environmentId: result.environmentId, ownerEpoch: 1, sessionId: null };
    const grant = workerService.takeMintedCredential(binding);
    expect(grant).toMatchObject({
      credential: CREDENTIAL,
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(workerService.acknowledgeCredentialDelivery(grant!)).toBe(true);
    expect(store.getCredential(result.environmentId)).toMatchObject({ deliveredAtMs: nowMs });
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
  });

  it("adopts a matching milestone-1 row that predates worker credentials", async () => {
    const environmentId = "worker-milestone-one";
    seedReady(environmentId);
    database.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(environmentId);
    database.db
      .prepare("UPDATE worker_environments SET owner_epoch = 0 WHERE environment_id = ?")
      .run(environmentId);
    const workerService = createService(
      createProvider({
        inspect: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    await workerService.reconcileOnce();

    expect(store.get(environmentId)?.ownerEpoch).toBe(1);
    expect(store.getCredential(environmentId)).toMatchObject({ ownerEpoch: 1, sessionId: null });
    expect(
      workerService.takeMintedCredential({ environmentId, ownerEpoch: 1, sessionId: null }),
    ).toMatchObject({
      credential: CREDENTIAL,
      ownerEpoch: 1,
    });
    expect(store.get(environmentId)?.lastError).toBe("provider unavailable");
    expect(bootstrapWorker).not.toHaveBeenCalled();
  });

  it("admits an npm-installed worker from canonical bundle identity without registry access", async () => {
    const environmentId = "worker-npm-admission";
    seedReady(environmentId, "npm");
    prepareInstallation = vi.fn(async (install) => {
      if (install === "npm") {
        throw new Error("registry unavailable");
      }
      return BUNDLE_ARTIFACT;
    });
    const workerService = createService(createProvider());

    await expect(workerService.admitWorker(admissionFor(environmentId))).resolves.toMatchObject({
      ok: true,
    });
    expect(prepareInstallation).toHaveBeenCalledTimes(1);
    expect(prepareInstallation).toHaveBeenCalledWith("bundle");
  });

  it("fences transcript commits by current epoch and exact session credential binding", async () => {
    const environmentId = "worker-transcript-fence";
    const sessionId = "session-transcript-fence";
    const identity = seedAttachedIdentity(environmentId, sessionId);
    const applyTranscriptCommit = vi.fn(async () => ({
      ok: true as const,
      result: { entryIds: ["entry-1"], newLeafId: "entry-1" },
    }));
    const workerService = createService(createProvider(), { applyTranscriptCommit });
    const request = {
      runEpoch: identity.ownerEpoch,
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

    await expect(workerService.commitTranscript(identity, request)).resolves.toMatchObject({
      ok: true,
    });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();

    await expect(
      workerService.commitTranscript(identity, {
        ...request,
        runEpoch: identity.ownerEpoch + 1,
        seq: 2,
      }),
    ).resolves.toEqual({ ok: false, reason: "epoch-mismatch" });
    database.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(workerService.commitTranscript(identity, { ...request, seq: 2 })).resolves.toEqual(
      { ok: false, reason: "session-not-attached" },
    );
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("admits only a gateway-preclaimed worker placement and fences later requests", async () => {
    const environmentId = "worker-placement-fence";
    const sessionId = "session-placement-fence";
    const identity = seedAttachedIdentity(environmentId, sessionId);
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    const workerService = createService(createProvider(), { placementStore });
    const admission = {
      environmentId,
      credential: [CREDENTIAL, environmentId, sessionId].join("-"),
      sessionId,
      runId: "run-1",
      ownerEpoch: identity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: BOOTSTRAP_RECEIPT,
    };

    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    expect(placementStore.validateWorkerTurn).toHaveBeenLastCalledWith({
      sessionId,
      environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: "run-1",
    });
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(2);
    expect(workerService.validateWorkerConnection(identity)).toBeNull();

    const warmEnvironmentId = "worker-placement-warm";
    seedReady(warmEnvironmentId);
    const warmAdmission = await workerService.admitWorker(admissionFor(warmEnvironmentId));
    expect(warmAdmission).toMatchObject({ ok: true });
    if (!warmAdmission.ok) {
      throw new Error("warm worker admission failed");
    }
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBeNull();
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(3);

    placementStore.validateWorkerTurn.mockReturnValue(false);
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-conflict" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });

    placementStore.validateWorkerTurn.mockReturnValue(true);
    nowMs += 10_000;
    expect(workerService.validateWorkerConnection(identity)).toBeNull();
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBe(
      "credential-expired",
    );
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "credential-expired",
    });

    placementStore.validateWorkerTurn.mockReturnValue(false);
    expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
    await expect(
      workerService.commitTranscript(identity, {
        runEpoch: identity.ownerEpoch,
        seq: 1,
        baseLeafId: null,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "fenced" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
  });

  it("persists worker transcript and terminal live ACK cursors", async () => {
    const identity = seedAttachedIdentity("worker-placement-ack", "session-placement-ack");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    const applyTranscriptCommit = vi.fn(async () => ({
      ok: true as const,
      result: { entryIds: ["entry-placement"], newLeafId: "entry-placement" },
    }));
    const liveEvents = createLiveEvents({
      apply: vi.fn(
        ({
          request,
        }: Parameters<NonNullable<WorkerEnvironmentServiceOptions["liveEvents"]>["apply"]>[0]) => ({
          ok: true as const,
          result: { ackedSeq: request.seq },
        }),
      ),
    });
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      liveEvents,
      placementStore,
    });
    const binding = {
      sessionId: identity.sessionId ?? "session-missing",
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: identity.runId ?? "run-missing",
    };

    await expect(
      workerService.commitTranscript(identity, {
        runEpoch: identity.ownerEpoch,
        seq: 7,
        baseLeafId: null,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "commit" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      ...binding,
      transcriptSeq: 7,
    });

    await expect(
      workerService.pushLiveEvent(identity, {
        runEpoch: identity.ownerEpoch,
        lastAckedSeq: 0,
        seq: 1,
        runId: binding.runId,
        event: { kind: "lifecycle", payload: { phase: "end", endedAt: 2 } },
      }),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
      ...binding,
      liveSeq: 1,
      workspaceResultPending: true,
    });
  });

  it("does not ACK a transcript commit after its worker claim is fenced", async () => {
    const identity = seedAttachedIdentity("worker-placement-race", "session-placement-race");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = vi.fn(async () => {
      await commitBlocked;
      return {
        ok: true as const,
        result: { entryIds: ["entry-placement-race"], newLeafId: "entry-placement-race" },
      };
    });
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      placementStore,
    });

    const commit = workerService.commitTranscript(identity, {
      runEpoch: identity.ownerEpoch,
      seq: 1,
      baseLeafId: null,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "commit before claim fence" }],
          timestamp: 1,
        },
      ],
    });
    await waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    placementStore.validateWorkerTurn.mockReturnValue(false);
    finishCommit?.();

    await expect(commit).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(2);
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
  });

  it("advances the transcript cursor when a stale-base commit consumes its sequence", async () => {
    const identity = seedAttachedIdentity("worker-placement-stale", "session-placement-stale");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    const applyTranscriptCommit = vi
      .fn<NonNullable<WorkerEnvironmentServiceOptions["applyTranscriptCommit"]>>()
      .mockResolvedValueOnce({ ok: false, reason: "stale-base-leaf" })
      .mockResolvedValueOnce({ ok: false, reason: "invalid-batch" });
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      placementStore,
    });
    const request = {
      runEpoch: identity.ownerEpoch,
      seq: 11,
      baseLeafId: "stale-leaf",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "stale commit" }],
          timestamp: 1,
        },
      ],
    };

    await expect(workerService.commitTranscript(identity, request)).resolves.toEqual({
      ok: false,
      reason: "stale-base-leaf",
    });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      sessionId: identity.sessionId,
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: identity.runId,
      transcriptSeq: 11,
    });

    await expect(
      workerService.commitTranscript(identity, { ...request, seq: 12 }),
    ).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
  });

  it("fences after a buffered terminal event becomes acknowledged by a gap fill", async () => {
    const identity = seedAttachedIdentity("worker-placement-gap", "session-placement-gap");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    const applyTranscriptCommit = vi.fn(async () => ({
      ok: true as const,
      result: { entryIds: ["entry-after-terminal-gap"], newLeafId: "entry-after-terminal-gap" },
    }));
    const liveApply = vi.fn(
      ({
        request,
      }: Parameters<NonNullable<WorkerEnvironmentServiceOptions["liveEvents"]>["apply"]>[0]) => ({
        ok: true as const,
        result: { ackedSeq: request.seq === 1 ? 2 : 0 },
      }),
    );
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      liveEvents: createLiveEvents({ apply: liveApply }),
      placementStore,
    });

    await expect(
      workerService.pushLiveEvent(identity, {
        runEpoch: identity.ownerEpoch,
        lastAckedSeq: 0,
        seq: 2,
        runId: identity.runId ?? "run-missing",
        event: { kind: "lifecycle", payload: { phase: "end", endedAt: 2 } },
      }),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      sessionId: identity.sessionId,
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: identity.runId,
      liveSeq: 0,
      workspaceResultPending: true,
    });

    await expect(
      workerService.pushLiveEvent(identity, {
        runEpoch: identity.ownerEpoch,
        lastAckedSeq: 0,
        seq: 1,
        runId: identity.runId ?? "run-missing",
        event: { kind: "assistant", payload: { text: "fills gap", delta: "fills gap" } },
      }),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    await expect(
      workerService.commitTranscript(identity, {
        runEpoch: identity.ownerEpoch,
        seq: 1,
        baseLeafId: null,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "late transcript" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.pushLiveEvent(identity, {
        runEpoch: identity.ownerEpoch,
        lastAckedSeq: 2,
        seq: 3,
        runId: identity.runId ?? "run-missing",
        event: { kind: "assistant", payload: { text: "late", delta: "late" } },
      }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).not.toHaveBeenCalled();
    expect(liveApply).toHaveBeenCalledTimes(2);
  });

  it("applies a terminal ACK only after its transcript commit finishes", async () => {
    const identity = seedAttachedIdentity("worker-placement-order", "session-placement-order");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = vi.fn(async () => {
      await commitBlocked;
      return {
        ok: true as const,
        result: { entryIds: ["entry-order"], newLeafId: "entry-order" },
      };
    });
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      liveEvents: createLiveEvents({
        apply: vi.fn(
          ({
            request,
          }: Parameters<
            NonNullable<WorkerEnvironmentServiceOptions["liveEvents"]>["apply"]
          >[0]) => ({ ok: true as const, result: { ackedSeq: request.seq } }),
        ),
      }),
      placementStore,
    });

    const commit = workerService.commitTranscript(identity, {
      runEpoch: identity.ownerEpoch,
      seq: 1,
      baseLeafId: null,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "commit before terminal" }],
          timestamp: 1,
        },
      ],
    });
    await waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    const terminal = workerService.pushLiveEvent(identity, {
      runEpoch: identity.ownerEpoch,
      lastAckedSeq: 0,
      seq: 1,
      runId: identity.runId ?? "run-missing",
      event: { kind: "lifecycle", payload: { phase: "end", endedAt: 2 } },
    });
    await Promise.resolve();
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    finishCommit?.();
    await expect(commit).resolves.toMatchObject({ ok: true });
    await expect(terminal).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors.mock.calls).toEqual([
      [
        {
          sessionId: identity.sessionId,
          environmentId: identity.environmentId,
          ownerEpoch: identity.ownerEpoch,
          runId: identity.runId,
          transcriptSeq: 1,
        },
      ],
      [
        {
          sessionId: identity.sessionId,
          environmentId: identity.environmentId,
          ownerEpoch: identity.ownerEpoch,
          runId: identity.runId,
          liveSeq: 1,
          workspaceResultPending: true,
        },
      ],
    ]);
  });

  it("fences post-terminal mutations while preserving sequenced replays", async () => {
    const identity = seedAttachedIdentity("worker-terminal-fence", "session-terminal-fence");
    const placementStore = {
      validateWorkerTurn: vi.fn(() => true),
      updateAckCursors: vi.fn(),
    };
    const applyTranscriptCommit = vi.fn(async () => ({
      ok: true as const,
      result: { entryIds: ["entry-terminal"], newLeafId: "entry-terminal" },
    }));
    const liveApply = vi.fn(
      ({
        request,
      }: Parameters<NonNullable<WorkerEnvironmentServiceOptions["liveEvents"]>["apply"]>[0]) => ({
        ok: true as const,
        result: { ackedSeq: request.seq },
      }),
    );
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      executeInference,
      liveEvents: createLiveEvents({ apply: liveApply }),
      placementStore,
    });
    const transcript = {
      runEpoch: identity.ownerEpoch,
      seq: 1,
      baseLeafId: null,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "terminal fence" }],
          timestamp: 1,
        },
      ],
    };
    const terminal = {
      runEpoch: identity.ownerEpoch,
      lastAckedSeq: 0,
      seq: 1,
      runId: identity.runId ?? "run-missing",
      event: { kind: "lifecycle" as const, payload: { phase: "end" as const, endedAt: 2 } },
    };

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      workerService.commitTranscript(identity, { ...transcript, seq: 2 }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(2);

    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });
    await expect(
      workerService.pushLiveEvent(identity, {
        ...terminal,
        seq: 2,
        event: { kind: "assistant", payload: { text: "late", delta: "late" } },
      }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(liveApply).toHaveBeenCalledTimes(2);

    expect(
      workerService.startInference(identity, inferenceRequest(identity), {
        connectionId: "connection-terminal-fence",
        send: vi.fn(),
      }),
    ).toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(workerService.cancelInference(identity, inferenceRequest(identity))).toEqual({
      ok: false,
      closeReason: "placement-mismatch",
    });
    expect(executeInference).not.toHaveBeenCalled();

    const rotatedCredentialHash = hashWorkerCredential(
      ["rotated", identity.environmentId, identity.sessionId].join("-"),
    );
    database.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(rotatedCredentialHash, identity.environmentId);
    const rotatedIdentity = { ...identity, credentialHash: rotatedCredentialHash };
    await expect(
      workerService.commitTranscript(rotatedIdentity, { ...transcript, seq: 2 }),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(3);
  });

  it("does not treat a terminal event on an already ACKed sequence as authoritative", async () => {
    const identity = seedAttachedIdentity("worker-terminal-reuse", "session-terminal-reuse");
    const applyTranscriptCommit = vi.fn(async () => ({
      ok: true as const,
      result: { entryIds: ["entry-after-reuse"], newLeafId: "entry-after-reuse" },
    }));
    const workerService = createService(createProvider(), {
      applyTranscriptCommit,
      liveEvents: createLiveEvents({
        apply: vi.fn(
          ({
            request,
          }: Parameters<
            NonNullable<WorkerEnvironmentServiceOptions["liveEvents"]>["apply"]
          >[0]) => ({ ok: true as const, result: { ackedSeq: request.seq } }),
        ),
      }),
      placementStore: {
        validateWorkerTurn: vi.fn(() => true),
        updateAckCursors: vi.fn(),
      },
    });
    const event = {
      runEpoch: identity.ownerEpoch,
      lastAckedSeq: 0,
      seq: 1,
      runId: identity.runId ?? "run-missing",
      event: { kind: "assistant" as const, payload: { text: "first", delta: "first" } },
    };

    await expect(workerService.pushLiveEvent(identity, event)).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.pushLiveEvent(identity, {
        ...event,
        event: { kind: "lifecycle", payload: { phase: "end", endedAt: 2 } },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.commitTranscript(identity, {
        runEpoch: identity.ownerEpoch,
        seq: 1,
        baseLeafId: null,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "still mutable" }],
            timestamp: 1,
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("fences inference by epoch and the durable session credential", async () => {
    const identity = seedAttachedIdentity("worker-inference-fence", "session-inference-fence");
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const workerService = createService(createProvider(), { executeInference });
    const request = inferenceRequest(identity);
    expect(
      workerService.startInference(
        identity,
        { ...request, sessionId: "session-other" },
        { connectionId: "connection-a", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "session-not-attached" });
    expect(
      workerService.startInference(
        identity,
        { ...request, runEpoch: request.runEpoch + 1 },
        { connectionId: "connection-b", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "epoch-mismatch" });

    const send = vi.fn();
    const started = workerService.startInference(identity, request, {
      connectionId: "connection-c",
      send,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    database.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(
        hashWorkerCredential(["replacement", identity.environmentId].join("-")),
        identity.environmentId,
      );
    started.launch();
    await waitForFast(() => expect(send).toHaveBeenCalledOnce());
    expect(executeInference).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: { reason: "session-not-attached" } },
    });
  });

  it("fences and rotates live credentials", async () => {
    const environmentId = "worker-live";
    const sessionId = "session-live";
    const identity = seedAttachedIdentity(environmentId, sessionId);
    const liveEvents = createLiveEvents();
    let inferenceSignal: AbortSignal | undefined;
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async ({ signal }) => {
        inferenceSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { type: "error", reason: "cancelled", message: "Inference cancelled" };
      },
    );
    const workerService = createService(createProvider(), { executeInference, liveEvents });
    const request = { ...LIVE_EVENT, runEpoch: identity.ownerEpoch };
    const push = workerService.pushLiveEvent.bind(workerService, identity);
    await push(request);
    await expect(push({ ...request, runEpoch: identity.ownerEpoch + 1 })).resolves.toEqual({
      ok: false,
      details: { reason: "epoch-mismatch" },
    });
    const started = workerService.startInference(identity, inferenceRequest(identity), {
      connectionId: "connection-rotation",
      send: vi.fn(),
    });
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    started.launch();
    await waitForFast(() => expect(executeInference).toHaveBeenCalledOnce());
    database.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(push({ ...request, seq: 2 })).resolves.toEqual({
      ok: false,
      details: { reason: "session-not-attached" },
    });
    liveEvents.rotateCredential.mockClear();
    nowMs += 10_000;
    await workerService.reconcileOnce();
    expect(inferenceSignal?.aborted).toBe(true);
    expect(liveEvents.rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialHash: store.getCredential(environmentId)?.credentialHash,
        previousCredentialHash: identity.credentialHash,
        runEpoch: identity.ownerEpoch,
      }),
    );
  });

  it("repairs duplicate session owners", async () => {
    const sessionId = "legacy";
    const older = seedAttachedIdentity("legacy-a", sessionId);
    const newer = seedAttachedIdentity("legacy-b", "other");
    database.db.exec(`
      UPDATE worker_environments SET attached_session_ids_json = '["legacy"]'
        WHERE environment_id = 'legacy-b';
      UPDATE worker_environment_credentials SET session_id = 'legacy'
        WHERE environment_id = 'legacy-b';
    `);

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    const liveEvents = createLiveEvents();
    const workerService = createService(createProvider(), { liveEvents });
    const event = { ...LIVE_EVENT, runEpoch: newer.ownerEpoch };
    await expect(workerService.pushLiveEvent(older, event)).resolves.toEqual({
      ok: false,
      closeReason: "credential-replaced",
    });
    await workerService.pushLiveEvent({ ...newer, sessionId }, event);
    expect(liveEvents.apply).toHaveBeenCalledOnce();
  });

  it("rejects attach before current bootstrap", async () => {
    const staleId = "worker-stale-attach";
    const bootstrapping = seedBootstrapping(staleId);
    store.transition({
      environmentId: staleId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(staleId, { ...BOOTSTRAP_RECEIPT, bundleHash: "c".repeat(64) }),
    });
    const workerService = createService(createProvider());

    await expect(
      workerService.attachSession({
        environmentId: staleId,
        ownerEpoch: 1,
        sessionId: "session-1",
      }),
    ).rejects.toThrow("must bootstrap the current build");
    expect(store.get(staleId)).toMatchObject({ state: "ready", attachedSessionIds: [] });
  });

  it("returns a bounded error when another worker owns the session", async () => {
    const firstId = "worker-session-owner";
    const secondId = "worker-session-contender";
    seedReady(firstId);
    seedReady(secondId);
    const workerService = createService(createProvider());

    await workerService.attachSession({
      environmentId: firstId,
      ownerEpoch: 1,
      sessionId: "session-owned",
    });
    await expect(
      workerService.attachSession({
        environmentId: secondId,
        ownerEpoch: 1,
        sessionId: "session-owned",
      }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message:
        "Session session-owned is already attached to worker environment worker-session-owner",
    });
    expect(store.get(secondId)).toMatchObject({ state: "ready", attachedSessionIds: [] });
  });

  it("requires session reclaim before operator destruction of an attached worker", async () => {
    const environmentId = "worker-session-reclaim";
    seedReady(environmentId);
    const workerService = createService(createProvider());
    await workerService.attachSession({
      environmentId,
      ownerEpoch: 1,
      sessionId: "session-reclaim",
    });

    await expect(workerService.destroyUnattached(environmentId)).rejects.toMatchObject({
      code: "invalid_state",
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
    expect(store.get(environmentId)).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-reclaim"],
    });
  });

  it("stops the tunnel after live binding rollback", async () => {
    const environmentId = "live-bind-fail";
    seedReady(environmentId);
    const liveEvents = createLiveEvents({
      bindSession: vi.fn(() => {
        throw new Error("bind failed");
      }),
    });
    const tunnelManager = {
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = createService(createProvider(), { liveEvents, tunnelManager });

    await expect(
      workerService.attachSession({ environmentId, ownerEpoch: 1, sessionId: "session-live" }),
    ).rejects.toThrow("Attached session target is unavailable");
    expect(tunnelManager.stop).toHaveBeenCalledWith(environmentId, 1);
    expect(store.get(environmentId)).toMatchObject({ state: "idle", attachedSessionIds: [] });
  });

  it("renews in place and binds delivery acknowledgement to the exact grant", async () => {
    const environmentId = "worker-credential-replacement";
    seedReady(environmentId);
    let credentialSequence = 0;
    const workerService = createService(createProvider(), {
      generateWorkerCredential: () => [CREDENTIAL, String(++credentialSequence)].join("-"),
      workerCredentialTtlMs: 100,
    });

    const binding = { environmentId, ownerEpoch: 1, sessionId: null };
    await workerService.reconcileOnce();
    const previous = workerService.takeMintedCredential(binding)!;
    nowMs += 100;
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    await workerService.reconcileOnce();
    const renewal = workerService.takeMintedCredential(binding)!;
    expect(renewal).toMatchObject({ ownerEpoch: 1, sessionId: null });
    expect(store.get(environmentId)?.ownerEpoch).toBe(1);
    expect(workerService.acknowledgeCredentialDelivery(previous)).toBe(false);
    expect(workerService.takeMintedCredential(binding)).toMatchObject({
      deliveryId: renewal.deliveryId,
    });
    expect(workerService.acknowledgeCredentialDelivery(renewal)).toBe(true);
  });

  it("recovers an undelivered atomic session credential after restart without changing owner", async () => {
    const environmentId = "worker-attach-restart";
    seedReady(environmentId);
    let credentialSequence = 0;
    const stopTunnel = vi.fn(async () => {
      throw new Error("tunnel stop interrupted");
    });
    const tunnelManager = {
      start: vi.fn(),
      stop: stopTunnel,
      stopAll: vi.fn(async () => {}),
      status: () => "stopped" as const,
    } as WorkerTunnelManager;
    const options = {
      generateWorkerCredential: () => [CREDENTIAL, String(++credentialSequence)].join("-"),
      tunnelManager,
    };
    const first = createService(createProvider(), options);
    await first.reconcileOnce();
    await expect(
      first.attachSession({ environmentId, ownerEpoch: 1, sessionId: "session-1" }),
    ).rejects.toThrow("tunnel stop interrupted");
    const binding = { environmentId, ownerEpoch: 2, sessionId: "session-1" };
    const lostHash = store.getCredential(environmentId)?.credentialHash;

    expect(stopTunnel).toHaveBeenCalledWith(environmentId, 1);
    expect(store.get(environmentId)).toMatchObject({ state: "attached", ownerEpoch: 2 });
    expect(first.takeMintedCredential(binding)).toBeUndefined();

    await first.stop();
    const restarted = createService(createProvider(), options);
    await restarted.reconcileOnce();

    const recovered = restarted.takeMintedCredential(binding);
    expect(recovered?.deliveryId).not.toBe(lostHash);
    expect(restarted.acknowledgeCredentialDelivery(recovered!)).toBe(true);
    const deliveredHash = store.getCredential(environmentId)?.credentialHash;

    await restarted.stop();
    const deliveredRestart = createService(createProvider(), options);
    await deliveredRestart.reconcileOnce();
    expect(deliveredRestart.takeMintedCredential(binding)).toBeUndefined();
    expect(store.getCredential(environmentId)?.credentialHash).toBe(deliveredHash);
  });

  it("stays bootstrapping until the SSH install receipt is durable", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return BOOTSTRAP_RECEIPT;
    });
    const creation = createService(createProvider()).create("development", "request-bootstrap");

    await waitForFast(() =>
      expect(store.list()[0]).toMatchObject({
        state: "bootstrapping",
        bootstrapReceipt: null,
      }),
    );
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
  });

  it("records installation preparation failure before allocating a lease", async () => {
    prepareInstallation = vi.fn(async () => {
      throw new Error("npm install requires a released gateway package");
    });
    const provision = vi.fn(createProvider().provision);
    const workerService = createService(createProvider({ provision }));

    await expect(
      workerService.create("development", "request-preparation-failure"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(provision).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "npm install requires a released gateway package",
    });
  });

  it("keeps a remotely bootstrapped lease retryable when receipt persistence fails", async () => {
    const durableStore = store;
    let persistenceFails = true;
    store = {
      ...store,
      transition(input) {
        if (persistenceFails && input.from === "bootstrapping" && input.to === "ready") {
          persistenceFails = false;
          throw new Error("receipt database write failed");
        }
        return durableStore.transition(input);
      },
    };
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }));

    await expect(
      workerService.create("development", "request-receipt-write-failure"),
    ).rejects.toThrow("receipt database write failed");
    expect(store.list()[0]).toMatchObject({ state: "bootstrapping", leaseId: "lease-1" });
    expect(destroy).not.toHaveBeenCalled();

    await workerService.reconcileOnce();
    expect(store.list()[0]).toMatchObject({ state: "ready", bootstrapReceipt: BOOTSTRAP_RECEIPT });
    expect(bootstrapWorker).toHaveBeenCalledTimes(2);
  });

  it("tears down the lease and records a bounded bootstrap failure", async () => {
    // Assembled at runtime so review-bundle secret scanners do not flag a key-shaped literal.
    const secret = ["sk", "proj", "bootstrap", "abcdefghijklmnopqrstuvwxyz"].join("-");
    bootstrapWorker = vi.fn(async () => {
      throw new Error(`remote bootstrap rejected ${secret}`);
    });
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }));

    await expect(
      workerService.create("development", "request-bootstrap-failure"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      lastError: expect.stringContaining("remote bootstrap rejected"),
    });
    expect(store.list()[0]?.lastError).not.toContain(secret);
  });

  it("keeps an indeterminate bootstrap teardown retryable", async () => {
    bootstrapWorker = vi.fn(async () => {
      throw new Error("remote bootstrap failed");
    });
    let teardownFails = true;
    const workerService = createService(
      createProvider({
        destroy: async () => {
          if (teardownFails) {
            throw new Error("provider teardown timed out");
          }
        },
      }),
    );

    await expect(
      workerService.create("development", "request-bootstrap-cleanup"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.list()[0]).toMatchObject({
      state: "destroying",
      leaseId: "lease-1",
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });

    teardownFails = false;
    await workerService.reconcileOnce();
    expect(store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: expect.stringContaining("remote bootstrap failed"),
    });
  });

  it("bounds worker identity resolution as a provider operation", async () => {
    bootstrapWorker = vi.fn(async ({ installation, resolveIdentity }) => {
      await resolveIdentity(SSH_ENDPOINT.keyRef);
      return {
        bundleHash: installation.bundleHash,
        openclawVersion: installation.openclawVersion,
        protocolFeatures: [...installation.protocolFeatures],
      };
    });
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }), {
      providerCallTimeoutMs: 5,
      resolveSshIdentity: async () => await new Promise<never>(() => {}),
    });

    await expect(
      workerService.create("development", "request-identity-timeout"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(destroy).toHaveBeenCalledOnce();
    expect(store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("aborts a timed-out SSH bootstrap before tearing down its lease", async () => {
    const events: string[] = [];
    bootstrapWorker = vi.fn(
      async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              reject(new Error("SSH bootstrap aborted"));
            },
            { once: true },
          );
        }),
    );
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const workerService = createService(createProvider({ destroy }), {
      bootstrapCallTimeoutMs: 10,
    });

    await expect(
      workerService.create("development", "request-bootstrap-timeout"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(events).toEqual(["abort", "destroy"]);
    expect(store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("replays an indeterminate provision failure with the same operation id", async () => {
    const calls: string[] = [];
    let fail = true;
    const secret = ["sk", "proj", "provision", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const provider = createProvider({
      provision: async (_profile, operationId) => {
        calls.push(operationId);
        if (fail) {
          throw new Error(`provider timeout ${secret}`);
        }
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
    });
    const workerService = createService(provider);

    await expect(workerService.create("development", "request-1")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = store.list()[0]?.environmentId;
    expect(environmentId).toBeTruthy();
    expect(store.get(environmentId!)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
    expect(store.get(environmentId!)?.lastError).not.toContain(secret);

    fail = false;
    await workerService.reconcileOnce();

    expect(store.get(environmentId!)).toMatchObject({
      state: "ready",
      leaseId: "lease-1",
      lastError: null,
    });
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = createService(provider);

    await expect(
      workerService.create("development", "request-lost-provision"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = createService(createProvider({ provision: async () => result as never }));

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });

  it("rejects plaintext secret fields before persisting intent", async () => {
    getDevelopmentProfile().settings = {
      keyRef: "not-a-secret-ref",
    };
    const provision = vi.fn(createProvider().provision);

    await expect(
      createService(createProvider({ provision })).create("development", "request-secret"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = createService(provider);

    await expect(workerService.create("development", "request-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = expectDefined(store.list()[0], "store.list()[0] test invariant");
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = createService(createProvider());

    await expect(workerService.create(" development ", "request-spaced")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.list()).toEqual([]);
  });

  it.each(["direct destroy", "restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(createProvider().provision);
      const workerService = createService(createProvider({ provision }));

      if (mode === "direct destroy") {
        await workerService.destroy(intent.environmentId);
      } else {
        store.requestDestroy({ environmentId: intent.environmentId, state: "requested" });
        providersEnabled = false;
        await workerService.reconcileOnce();
      }

      expect(provision).not.toHaveBeenCalled();
      expect(store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );

  it("inspects a persisted lease with its profile snapshot after profile removal", async () => {
    seedBootstrapping("worker-crash");
    config.cloudWorkers!.profiles = {};
    const inspected: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        return { status: "active" };
      },
      provision: async () => {
        throw new Error("provision must not run for a known lease");
      },
    });

    await createService(provider).reconcileOnce();

    expect(inspected).toEqual([{ leaseId: "lease:worker-crash", profile: { region: "test" } }]);
    expect(store.get("worker-crash")).toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
    expect(prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("skips an active lease whose durable receipt matches the lifecycle bundle", async () => {
    seedReady("worker-current");

    await createService(createProvider()).reconcileOnce();

    expect(store.get("worker-current")).toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
    expect(prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(bootstrapWorker).not.toHaveBeenCalled();
  });

  it("re-enters bootstrapping when the durable receipt has a stale bundle hash", async () => {
    const bootstrapping = seedBootstrapping("worker-stale");
    store.transition({
      environmentId: bootstrapping.environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(bootstrapping.environmentId, {
        ...BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });

    await createService(createProvider()).reconcileOnce();

    expect(store.get("worker-stale")).toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
    expect(bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("tears down an attached worker whose admitted bundle is stale", async () => {
    const environmentId = "worker-attached-stale";
    seedBootstrapping(environmentId);
    const ready = store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(environmentId, {
        ...BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });
    store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: attachedPatch(environmentId, "session-1"),
    });
    const destroy = vi.fn(async () => {});

    await createService(createProvider({ destroy })).reconcileOnce();

    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith({
      leaseId: `lease:${environmentId}`,
      profile: { region: "test" },
    });
    expect(store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: `lease:${environmentId}`,
      attachedSessionIds: [],
      lastError: null,
    });
  });

  it("does not resolve npm while an admitted receipt matches the local bundle", async () => {
    const environmentId = "worker-current-npm";
    seedReady(environmentId, "npm");
    prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return BUNDLE_ARTIFACT;
      }
      throw new Error("npm registry is unavailable");
    });
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }));

    await workerService.reconcileOnce();

    expect(prepareInstallation).toHaveBeenCalledTimes(1);
    expect(prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(destroy).not.toHaveBeenCalled();
    expect(store.get(environmentId)).toMatchObject({
      state: "ready",
      leaseId: `lease:${environmentId}`,
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
      lastError: null,
    });
  });

  it("keeps an admitted lease retryable when local bundle identity is unavailable", async () => {
    const environmentId = "worker-current-bundle-unavailable";
    seedReady(environmentId, "npm");
    const attachedId = "worker-attached-bundle-unavailable";
    seedReady(attachedId);
    store.transition({
      environmentId: attachedId,
      from: "ready",
      to: "attached",
      patch: attachedPatch(attachedId, "session-1"),
    });
    database.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(attachedId);
    prepareInstallation = vi.fn(async () => {
      throw new Error("local bundle identity is unavailable");
    });
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }));

    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(store.get(environmentId)).toMatchObject({
      state: "ready",
      leaseId: `lease:${environmentId}`,
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
      lastError: "local bundle identity is unavailable",
    });
    expect(store.getCredential(attachedId)).toBeUndefined();
    expect(
      workerService.takeMintedCredential({
        environmentId: attachedId,
        ownerEpoch: 2,
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it.each(["bootstrapping", "ready", "idle"] as const)(
    "tears down a persisted %s lease when mismatched npm preparation fails",
    async (state) => {
      const environmentId = `worker-prepare-${state}`;
      const bootstrapping = seedBootstrapping(environmentId, "npm");
      if (state !== "bootstrapping") {
        const ready = store.transition({
          environmentId,
          from: bootstrapping.state,
          to: "ready",
          patch: readyPatch(environmentId, {
            ...BOOTSTRAP_RECEIPT,
            bundleHash: "c".repeat(64),
          }),
        });
        if (state === "idle") {
          store.transition({ environmentId, from: ready.state, to: "idle" });
        }
      }
      prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle") {
          return BUNDLE_ARTIFACT;
        }
        throw new Error("released npm artifact is unavailable");
      });
      const order: string[] = [];
      const tunnelManager = {
        status: () => "connected" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {
          order.push("tunnel-stop");
        }),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const destroy = vi.fn(async () => {
        order.push("provider-destroy");
      });

      await createService(createProvider({ destroy }), { tunnelManager }).reconcileOnce();

      expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
      expect(destroy).toHaveBeenCalledWith({
        leaseId: `lease:${environmentId}`,
        profile: { region: "test" },
      });
      expect(store.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        sshEndpoint: null,
        teardownTerminalState: "failed",
        lastError: "released npm artifact is unavailable",
      });
      expect(prepareInstallation).toHaveBeenCalledWith("bundle");
      expect(prepareInstallation).toHaveBeenCalledWith("npm");
      expect(bootstrapWorker).not.toHaveBeenCalled();
    },
  );

  it("retries indeterminate teardown after a reconcile preparation failure and restart", async () => {
    const environmentId = "worker-prepare-teardown-retry";
    const bootstrapping = seedBootstrapping(environmentId, "npm");
    store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(environmentId, {
        ...BOOTSTRAP_RECEIPT,
        bundleHash: "c".repeat(64),
      }),
    });
    prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return BUNDLE_ARTIFACT;
      }
      throw new Error("released npm artifact is unavailable");
    });
    let teardownFails = true;
    const destroy = vi.fn(async () => {
      if (teardownFails) {
        throw new Error("provider teardown timed out");
      }
    });
    const provider = createProvider({ destroy });
    const workerService = createService(provider);

    await workerService.reconcileOnce();
    expect(store.get(environmentId)).toMatchObject({
      state: "destroying",
      leaseId: `lease:${environmentId}`,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });

    await workerService.stop();
    teardownFails = false;
    await createService(provider).reconcileOnce();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(store.get(environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });
  });

  it("uses the snapshotted npm selection after live config changes", async () => {
    getDevelopmentProfile().install = "npm";
    const provider = createProvider({
      provision: async () => {
        getDevelopmentProfile().install = "bundle";
        return { leaseId: "lease-npm", ssh: SSH_ENDPOINT };
      },
    });

    const result = await createService(provider).create("development", "request-npm");

    expect(result).toMatchObject({
      state: "ready",
      profileSnapshot: { install: "npm" },
    });
    expect(prepareInstallation).toHaveBeenCalledWith("npm");
    expect(bootstrapWorker).toHaveBeenCalledWith({
      sshEndpoint: SSH_ENDPOINT,
      installation: NPM_ARTIFACT,
      resolveIdentity: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  it("orphans unknown active leases and adopts unknown expected teardown", async () => {
    seedReady("worker-unknown");
    seedReady("worker-transient");
    seedReady("worker-destroyed-unknown");
    store.requestDestroy({ environmentId: "worker-destroyed-unknown", state: "ready" });
    store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "ready",
      to: "draining",
    });
    store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "draining",
      to: "destroying",
    });
    const provider = createProvider({
      inspect: async ({ leaseId }) => {
        if (leaseId !== "lease:worker-transient") {
          return { status: "unknown" };
        }
        throw new Error("provider temporarily unavailable");
      },
    });
    const failedTunnelStops = new Set<string>();
    const tunnelManager = {
      start: vi.fn(),
      stop: vi.fn(async (environmentId: string) => {
        if (!failedTunnelStops.has(environmentId)) {
          failedTunnelStops.add(environmentId);
          throw new Error("tunnel stop interrupted");
        }
      }),
      stopAll: vi.fn(async () => {}),
      status: () => "connected" as const,
    } as unknown as WorkerTunnelManager;
    const workerService = createService(provider, { tunnelManager });
    const admitted = await workerService.admitWorker(admissionFor("worker-unknown"));
    if (!admitted.ok) {
      throw new Error("fixture worker admission failed");
    }

    await workerService.reconcileOnce();

    expect(store.get("worker-unknown")?.state).toBe("draining");
    expect(store.get("worker-destroyed-unknown")?.state).toBe("destroying");
    expect(workerService.validateWorkerConnection(admitted.identity)).toBe("credential-replaced");
    expect(store.get("worker-transient")).toMatchObject({
      state: "ready",
      lastError: "provider temporarily unavailable",
    });
    await workerService.reconcileOnce();
    expect(tunnelManager.stop).toHaveBeenCalledTimes(4);
    expect(store.get("worker-unknown")?.state).toBe("orphaned");
    expect(store.get("worker-destroyed-unknown")).toMatchObject({ state: "destroyed" });
  });

  it.each([null, { status: "future" }])(
    "retains retryable state for malformed inspection result %#",
    async (inspection) => {
      seedReady("worker-malformed");
      const provider = createProvider({ inspect: async () => inspection as never });

      await createService(provider).reconcileOnce();

      expect(store.get("worker-malformed")).toMatchObject({
        state: "ready",
        lastError: expect.stringContaining("invalid inspection"),
      });
    },
  );

  it("adopts provider-proven teardown through legal terminal transitions", async () => {
    seedReady("worker-destroyed-ready");
    seedReady("worker-destroyed-attached");
    store.transition({
      environmentId: "worker-destroyed-attached",
      from: "ready",
      to: "attached",
      patch: attachedPatch("worker-destroyed-attached", "session-1"),
    });
    seedReady("worker-destroyed-draining");
    store.transition({
      environmentId: "worker-destroyed-draining",
      from: "ready",
      to: "draining",
    });
    const provider = createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy: async () => {
        throw new Error("destroy must not run for provider-proven teardown");
      },
    });

    await createService(provider).reconcileOnce();

    for (const environmentId of [
      "worker-destroyed-ready",
      "worker-destroyed-attached",
      "worker-destroyed-draining",
    ]) {
      expect(store.get(environmentId)).toMatchObject({
        state: "destroyed",
        attachedSessionIds: [],
      });
    }
  });

  it("adopts a provider-proven bootstrap teardown as failed after restart", async () => {
    const bootstrapping = seedBootstrapping("worker-bootstrap-teardown-crash");
    const requested = store.requestDestroy({
      environmentId: bootstrapping.environmentId,
      state: bootstrapping.state,
      terminalState: "failed",
      lastError: "remote bootstrap failed",
    });
    const draining = store.transition({
      environmentId: requested.environmentId,
      from: requested.state,
      to: "draining",
      patch: { lastError: requested.lastError },
    });
    store.transition({
      environmentId: draining.environmentId,
      from: draining.state,
      to: "destroying",
      patch: { lastError: draining.lastError },
    });
    const destroy = vi.fn(async () => {});
    const provider = createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy,
    });
    providersEnabled = false;
    const workerService = createService(provider);

    await workerService.reconcileOnce();
    expect(store.get(bootstrapping.environmentId)).toMatchObject({
      state: "destroying",
      lastError: "remote bootstrap failed",
    });

    providersEnabled = true;
    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(store.get(bootstrapping.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });
  });

  it("keeps a failed destroy retryable and makes completed destroy idempotent", async () => {
    seedReady("worker-destroy");
    config.cloudWorkers!.profiles = {};
    let fail = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      destroy: async (lease) => {
        destroyed.push(lease);
        if (fail) {
          throw new Error("destroy timeout");
        }
      },
    });
    const workerService = createService(provider);

    await expect(workerService.destroy("worker-destroy")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get("worker-destroy")).toMatchObject({
      state: "destroying",
      lastError: "destroy timeout",
    });

    fail = false;
    await workerService.reconcileOnce();
    expect(store.get("worker-destroy")).toMatchObject({ state: "destroyed" });
    await workerService.destroy("worker-destroy");
    expect(destroyed).toEqual([
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
    ]);
  });

  it("projects live tunnel status and fences the tunnel before provider teardown", async () => {
    seedReady("worker-tunnel");
    const order: string[] = [];
    let tunnelStatus: "stopped" | "connected" = "stopped";
    const tunnelManager = {
      status: () => tunnelStatus,
      start: vi.fn(async (request) => {
        tunnelStatus = "connected";
        return {
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          remoteSocketPath: "/tmp/worker/gateway.sock",
          runWorkspaceCommand: vi.fn(),
          syncWorkspace: vi.fn(),
          stop: async () => {},
        };
      }),
      stop: vi.fn(async () => {
        tunnelStatus = "stopped";
        order.push("tunnel-stop");
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = createService(provider, { tunnelManager });

    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 0 }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).not.toHaveBeenCalled();

    await workerService.startTunnel({
      environmentId: "worker-tunnel",
      ownerEpoch: 1,
    });
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: { host: "127.0.0.1", port: 18_789 } }),
    );
    expect(workerService.get("worker-tunnel")).toMatchObject({ tunnelStatus: "connected" });

    await workerService.destroy("worker-tunnel");
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(workerService.get("worker-tunnel")).toMatchObject({
      state: "destroyed",
      tunnelStatus: "stopped",
    });
  });

  it("fences a draining tunnel before reporting an unavailable provider", async () => {
    seedReady("worker-provider-missing");
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = createService(createProvider(), { tunnelManager });
    providersEnabled = false;

    await expect(workerService.destroy("worker-provider-missing")).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(tunnelManager.stop).toHaveBeenCalledWith("worker-provider-missing");
    expect(store.get("worker-provider-missing")).toMatchObject({
      state: "draining",
      destroyRequestedAtMs: expect.any(Number),
    });
  });

  it("does not hold the environment lock while a tunnel is connecting", async () => {
    seedReady("worker-tunnel-pending");
    let rejectStart: ((error: Error) => void) | undefined;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const order: string[] = [];
    const tunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => pendingStart),
      stop: vi.fn(async () => {
        order.push("tunnel-stop");
        rejectStart?.(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = createService(provider, { tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-pending",
      ownerEpoch: 1,
    });
    const rejectedStart = expect(starting).rejects.toThrow("tunnel stopped");
    await waitForFast(() => expect(tunnelManager.start).toHaveBeenCalledOnce());

    await workerService.destroy("worker-tunnel-pending");

    await rejectedStart;
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
  });

  it("adopts an unpersisted provision result before destroying", async () => {
    const intent = store.createIntent({
      environmentId: "worker-pending-destroy",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy",
    });
    store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      provision: async () => {
        expect(store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });

    const result = await createService(provider).destroy(intent.environmentId);

    expect(result.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-1", profile: { region: "test" } }]);
  });

  it("retains teardown intent across an indeterminate provision failure", async () => {
    prepareInstallation = vi.fn(async () => {
      throw new Error("bundle preparation must not block teardown adoption");
    });
    const intent = store.createIntent({
      environmentId: "worker-pending-destroy-retry",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy-retry",
    });
    store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    let provisionFails = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      provision: async () => {
        if (provisionFails) {
          throw new Error("provision outcome unknown");
        }
        return { leaseId: "lease-retried", ssh: SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });
    const workerService = createService(provider);

    providersEnabled = false;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();

    providersEnabled = true;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: expect.any(Number),
    });

    provisionFails = false;
    await workerService.reconcileOnce();
    expect(store.get(intent.environmentId)?.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-retried", profile: { region: "test" } }]);
    expect(prepareInstallation).not.toHaveBeenCalled();
  });

  it("reconciles unrelated leases concurrently", async () => {
    seedReady("worker-concurrent-a");
    seedReady("worker-concurrent-b");
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspected: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        await blocked;
        return { status: "active" };
      },
    });

    const reconciliation = createService(provider).reconcileOnce();
    try {
      await waitForFast(() => expect(inspected).toHaveLength(2));
    } finally {
      release?.();
    }
    await reconciliation;

    expect(new Set(inspected.map(({ leaseId }) => leaseId))).toEqual(
      new Set(["lease:worker-concurrent-a", "lease:worker-concurrent-b"]),
    );
  });

  it("owns and clears one periodic reconciliation timer", async () => {
    vi.useFakeTimers();
    const liveEvents = createLiveEvents();
    const workerService = createService(createProvider(), { liveEvents });

    workerService.start();
    workerService.start();
    expect(liveEvents.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a create queued before service shutdown once its lock is acquired", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return BOOTSTRAP_RECEIPT;
    });
    const provision = vi.fn(createProvider().provision);
    const workerService = createService(createProvider({ provision }));
    const first = workerService.create("development", "request-queued-before-stop");
    await waitForFast(() => expect(bootstrapWorker).toHaveBeenCalledTimes(1));
    const queued = workerService.create("development", "request-queued-before-stop");
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(first).resolves.toMatchObject({ state: "ready" });
    await queuedResult;
    await stopping;
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("drains a destroy accepted before service shutdown while it waits for the lock", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {});
    const workerService = createService(createProvider({ destroy }));
    const creation = workerService.create("development", "request-destroy-before-stop");
    await waitForFast(() => expect(bootstrapWorker).toHaveBeenCalledTimes(1));
    const environmentId = store.list()[0]?.environmentId;
    expect(environmentId).toBeTruthy();
    const teardown = workerService.destroy(environmentId!);
    const teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await teardownResult;
    await stopping;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("drains accepted operations after reconciliation rejects during shutdown", async () => {
    const durableStore = store;
    store = {
      ...store,
      listForReconcile() {
        throw new Error("reconcile database read failed");
      },
    };
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return BOOTSTRAP_RECEIPT;
    });
    const workerService = createService(createProvider());
    const creation = workerService.create("development", "request-stop-after-reconcile-failure");
    await waitForFast(() => expect(bootstrapWorker).toHaveBeenCalledTimes(1));
    const reconciliation = workerService.reconcileOnce();
    const reconciliationResult = expect(reconciliation).rejects.toThrow(
      "reconcile database read failed",
    );
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });

    await reconciliationResult;
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await stopping;
    expect(stopped).toBe(true);
    expect(durableStore.list()).toHaveLength(1);
  });

  it("starts without blocking gateway startup and drains reconciliation on stop", async () => {
    seedReady("worker-slow-inspection");
    let finishInspection: (() => void) | undefined;
    const inspectionPending = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });
    const inspect = vi.fn(async () => {
      await inspectionPending;
      return { status: "active" as const };
    });
    const workerService = createService(createProvider({ inspect }));

    workerService.start();
    await waitForFast(() => expect(inspect).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishInspection?.();
    await stopping;
    expect(stopped).toBe(true);
    await expect(workerService.create("development", "request-after-stop")).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(workerService.destroy("worker-slow-inspection")).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
