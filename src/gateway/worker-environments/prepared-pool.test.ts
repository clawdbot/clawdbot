import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { createPreparedWorkerPool } from "./prepared-pool.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import { createWorkerProviderProvisioner } from "./provider-provisioning.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentState } from "./state.js";
import { createWorkerEnvironmentStore } from "./store.js";
import {
  createWorkerEnvironmentServiceError,
  WorkerEnvironmentServiceError,
} from "./worker-error.js";

const PROJECT_KEY = "a".repeat(64);
const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
const IDLE_TIMEOUT_MS = 1_000;
const RECEIPT = { bundleHash: BUNDLE_HASH, openclawVersion: "2026.8.1", protocolFeatures: [] };
type PoolOptions = Parameters<typeof createPreparedWorkerPool>[0];

describe("prepared worker reserve lifecycle", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: ReturnType<typeof createWorkerEnvironmentStore>;
  let config: OpenClawConfig;
  let developmentProfile: CloudWorkerProfileConfig;
  let nowMs: number;
  let abort: AbortController;
  let provider: WorkerProvider;
  let service: WorkerEnvironmentService | undefined;
  let releases: Array<() => void>;
  let operations: Set<Promise<void>>;
  const openStore = () => {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  };
  const reopenStore = () => {
    closeOpenClawStateDatabaseForTest();
    openStore();
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-prepared-pool-"));
    nowMs = 1_000;
    abort = new AbortController();
    releases = [];
    operations = new Set();
    service = undefined;
    developmentProfile = { provider: "test-provider", settings: {} };
    config = { cloudWorkers: { profiles: { development: developmentProfile } } };
    provider = {
      id: "test-provider",
      resolvePreparedIdleTimeoutMs: () => IDLE_TIMEOUT_MS,
      resolveAllocation: vi.fn(async () => ({ leaseId: "resolved-lease", sharedHost: false })),
      provision: vi.fn(async () => ({ leaseId: "new-lease", node: { deviceId: "new-node" } })),
      inspect: vi.fn(async () => ({ status: "active" as const })),
      destroy: vi.fn(async () => {}),
      notePreparedDemand: vi.fn(async () => {}),
    };
    openStore();
  });

  afterEach(async () => {
    abort.abort();
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(operations);
    await service?.stop();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function profile(projectKey = PROJECT_KEY, preparationKey = PREPARATION_KEY): WorkerProfile {
    return {
      settings: {},
      executionMode: "worker-turn",
      project: {
        key: projectKey,
        root: path.join(root, projectKey),
        baseCommit: "d".repeat(40),
        preparation: {
          key: preparationKey,
          cacheKey: "9".repeat(64),
          contractVersion: 1,
          target: { machineClass: "standard", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "e".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: BUNDLE_HASH,
            workerArchiveSha256: "f".repeat(64),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
          },
        },
      },
    };
  }

  function seed(
    environmentId: string,
    options: { projectKey?: string; preparationKey?: string; reserve?: boolean } = {},
  ) {
    return store.createIntent({
      environmentId,
      providerId: provider.id,
      profileId: "development",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: profile(options.projectKey, options.preparationKey),
      preparation: options.reserve
        ? {
            key: options.preparationKey ?? PREPARATION_KEY,
            demandAtMs: nowMs,
            expiresAtMs: nowMs + IDLE_TIMEOUT_MS,
          }
        : undefined,
    });
  }

  function credential(value: string, sessionId: string | null = value) {
    return {
      credentialHash: hashWorkerCredential(value),
      sessionId,
      rpcSetVersion: 1,
      expiresAtMs: nowMs + 10_000,
    };
  }

  function ready({ environmentId }: WorkerEnvironmentRecord) {
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    return store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        sharedHost: false,
        bootstrapReceipt: RECEIPT,
        credential: credential(environmentId, null),
      },
    });
  }

  function attach(
    record: WorkerEnvironmentRecord,
    stage: "provisioning" | "syncing" | "active" = "active",
    activatedAtMs = nowMs,
  ) {
    const sessionId = `session:${record.environmentId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const executionMode = "worker-turn";
    const identity = { sessionId, sessionKey, agentId: "main", executionMode } as const;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const requested = placements.startDispatch(identity);
    const assigned = record.preparation
      ? placements.bindPreparedEnvironment({
          ...identity,
          expectedGeneration: requested.generation,
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          providerId: record.providerId,
          profileId: record.profileId,
          preparationKey: record.preparation.key,
          nodeDeviceId: record.nodeDeviceId!,
          leaseId: record.leaseId!,
          bundleHash: BUNDLE_HASH,
          assertCurrent: () => {},
        })!
      : placements.transition({
          sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: record.environmentId },
        });
    if (stage === "provisioning") {
      return store.get(record.environmentId)!;
    }
    const syncing = placements.transition({
      sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: assigned.generation,
      patch: { workerBundleHash: BUNDLE_HASH },
    });
    const placementBinding = record.preparation
      ? {
          ...identity,
          generation: syncing.generation,
          preparationKey: record.preparation.key,
          assertCurrent: () => {},
        }
      : undefined;
    const attached = store.transition({
      environmentId: record.environmentId,
      from: "ready",
      to: "attached",
      placementBinding,
      patch: {
        attachedSessionIds: [sessionId],
        credential: credential(sessionId),
      },
    });
    if (stage === "active") {
      const starting = placements.transition({
        sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: { workspaceBaseManifestRef: "manifest", remoteWorkspaceDir: "/workspace" },
      });
      nowMs = activatedAtMs;
      placements.transition({
        sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: starting.generation,
        patch: { activeOwnerEpoch: attached.ownerEpoch },
      });
    }
    return store.get(attached.environmentId)!;
  }

  function teardown(record: WorkerEnvironmentRecord) {
    const environmentId = record.environmentId;
    const sessionId = `session:${environmentId}`;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const placement = placements.get(sessionId)!;
    if (placement.state === "active") {
      const ownerEpoch = placement.activeOwnerEpoch;
      const owner = { sessionId, environmentId, ownerEpoch };
      const expectedGeneration = placement.generation;
      const draining = placements.startDrain({ ...owner, expectedGeneration });
      placements.startReconcile({ ...owner, expectedGeneration: draining.generation });
    }
    placements.fail({ sessionId, recoveryError: "session teardown" });
    store.requestDestroy({ environmentId, state: record.state });
    store.transition({ environmentId, from: record.state, to: "draining" });
    store.transition({ environmentId, from: "draining", to: "destroying" });
    store.transition({ environmentId, from: "destroying", to: "destroyed" });
  }

  function pool(overrides: Partial<PoolOptions> = {}) {
    return createPreparedWorkerPool({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      prepareIntent: async (_profileId, { projectPath }) => ({
        providerId: provider.id,
        profileSnapshot: profile(path.basename(projectPath)),
        preparationKey: PREPARATION_KEY,
      }),
      assertIntentCurrent: () => {},
      reconcile: async () => {},
      signal: abort.signal,
      now: () => nowMs,
      warn: vi.fn(),
      ...overrides,
    });
  }

  function schedule(owner: ReturnType<typeof pool>) {
    const operation = owner.schedule();
    operations.add(operation);
    const release = () => operations.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  const reserves = () => store.list().filter((record) => record.preparation !== null);

  it.each(["resolution", "idle policy"])(
    "cleans expired reserves and refills healthy projects after another provider's %s fails",
    async (failure) => {
      const expired = ready(seed("expired", { reserve: true }));
      nowMs = 1_500;
      attach(ready(seed("healthy", { projectKey: "c".repeat(64) })));
      config.cloudWorkers!.profiles!.broken = { provider: "broken" };
      attach(
        ready(
          store.createIntent({
            environmentId: "broken",
            providerId: "broken",
            profileId: "broken",
            profileSnapshot: profile(),
            provisionOperationId: "provision:broken",
          }),
        ),
      );
      nowMs = 2_000;
      const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
      const owner = pool({
        reconcile,
        resolveProvider: (id) => {
          if (id !== "broken") {
            return provider;
          }
          if (failure === "resolution") {
            throw new Error("provider resolution failed");
          }
          return {
            ...provider,
            resolvePreparedIdleTimeoutMs: () => {
              throw new Error("provider idle policy failed");
            },
          };
        },
      });
      await schedule(owner);
      expect(store.get(expired.environmentId)?.destroyRequestedAtMs).toBe(nowMs);
      expect(reconcile.mock.calls.map(([record]) => record)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            environmentId: expired.environmentId,
            destroyRequestedAtMs: nowMs,
          }),
          expect.objectContaining({ preparation: expect.objectContaining({ demandAtMs: 1_500 }) }),
        ]),
      );
    },
  );

  it.each(["available", "missing", "throwing"] as const)(
    "retains terminal demand beyond seven days with %s provider policy",
    async (policyState) => {
      const dayMs = 24 * 60 * 60 * 1_000;
      const source = attach(ready(seed("source")));
      teardown(source);
      const placements = createWorkerSessionPlacementStore({ database });
      const placement = placements.get(`session:${source.environmentId}`)!;
      placements.retireSessionPlacement({
        sessionId: placement.sessionId,
        expectedState: "failed",
        expectedGeneration: placement.generation,
      });
      reopenStore();
      nowMs += 8 * dayMs;
      provider.resolvePreparedIdleTimeoutMs = () => 10 * dayMs;
      const resolveProvider = () => {
        if (policyState === "throwing") {
          throw new Error("provider unavailable");
        }
        return policyState === "missing" ? undefined : provider;
      };
      const owner = pool({ resolveProvider });
      expect(store.pruneTerminalEnvironments({ canPruneDemand: owner.canPruneDemand })).toBe(0);
      expect(store.get(source.environmentId)?.lastActivatedAtMs).toBe(1_000);
      if (policyState === "available") {
        await schedule(owner);
        expect(reserves()).toHaveLength(1);
        expect(reserves()[0]?.preparation?.expiresAtMs).toBe(1_000 + 10 * dayMs);
      }
      nowMs += 2 * dayMs;
      // Policy recovery permits metadata cleanup only after the original deadline.
      expect(store.pruneTerminalEnvironments({ canPruneDemand: pool().canPruneDemand })).toBe(1);
      expect(store.get(source.environmentId)).toBeUndefined();
    },
  );

  it("keeps expiry tied to originating demand across repeated maintenance and database reopen", async () => {
    attach(ready(seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({ reconcile });
    await schedule(owner);
    const reserve = reserves()[0]!;
    expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
    nowMs = 1_900;
    await schedule(owner);
    expect(reserves()).toEqual([reserve]);
    expect(provider.notePreparedDemand).not.toHaveBeenCalled();

    reopenStore();
    nowMs = 2_000;
    await schedule(pool({ reconcile }));
    expect(reserves()).toHaveLength(1);
    expect(store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: 2_000,
      preparation: reserve.preparation,
    });
    expect(reconcile.mock.lastCall?.[0]).toMatchObject({ destroyRequestedAtMs: 2_000 });
    nowMs = 2_100;
    await schedule(pool());
    expect(reserves()).toHaveLength(1);
  });

  it("retains activated demand after consumed worker teardown and database reopen", async () => {
    const source = attach(ready(seed("source")));
    const owner = pool();
    await schedule(owner);
    const reserve = ready(reserves()[0]!);
    await owner.noteDemand(reserve.environmentId);
    expect(provider.notePreparedDemand).not.toHaveBeenCalled();
    nowMs = 1_500;
    await owner.noteDemand(source.environmentId);
    expect(provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: source.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_000 },
    );
    const consumed = attach(reserve);
    await owner.noteDemand(consumed.environmentId);
    expect(provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: consumed.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_500 },
    );
    teardown(source);
    teardown(consumed);
    reopenStore();
    await schedule(pool());
    expect(
      reserves().find((record) => record.preparation?.consumedAtMs === null)?.preparation,
    ).toMatchObject({ demandAtMs: 1_500, expiresAtMs: 2_500 });
    expect(store.get(consumed.environmentId)?.preparation).toMatchObject({
      consumedAtMs: 1_500,
      expiresAtMs: 2_000,
    });
  });

  it.each([
    ["provisioning", true, 1_950],
    ["provisioning", true, 2_050],
    ["syncing", false, 1_950],
    ["syncing", true, 2_050],
  ] as const)(
    "does not renew consumed %s demand (failed=%s) during maintenance at %s",
    async (stage, fail, maintenanceAtMs) => {
      const source = attach(ready(seed("source")));
      await schedule(pool());
      teardown(source);
      const reserve = ready(reserves()[0]!);
      nowMs = 1_900;
      const consumed = attach(reserve, stage);
      if (fail) {
        teardown(consumed);
      }
      reopenStore();
      nowMs = maintenanceAtMs;
      const owner = pool();
      await owner.noteDemand(consumed.environmentId);
      await schedule(owner);
      expect(provider.notePreparedDemand).not.toHaveBeenCalled();
      const replacement = reserves().filter((record) => record.preparation?.consumedAtMs === null);
      if (maintenanceAtMs < 2_000) {
        expect(replacement).toHaveLength(1);
        expect(replacement[0]?.preparation).toMatchObject({
          demandAtMs: 1_000,
          expiresAtMs: 2_000,
        });
        nowMs = 2_050;
        await schedule(owner);
        expect(reserves()).toHaveLength(2);
        expect(store.get(replacement[0]!.environmentId)?.destroyRequestedAtMs).toBe(2_050);
      } else {
        expect(replacement).toEqual([]);
      }
    },
  );

  it("does not seed demand from a cold attachment still syncing after database reopen", async () => {
    const attached = attach(ready(seed("syncing-cold")), "syncing");
    reopenStore();
    const owner = pool();
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    expect(provider.notePreparedDemand).not.toHaveBeenCalled();
    expect(reserves()).toEqual([]);
  });

  it.each(["checkout", "sync"])(
    "starts a full idle window after a long first %s without extending it on detach",
    async (phase) => {
      const idleWindow = 15 * 60_000;
      provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = ready(seed("slow-first-checkout"));
      const activatedAtMs = nowMs + 16 * 60_000;
      if (phase === "checkout") {
        nowMs = activatedAtMs;
      }
      const attached = attach(allocated, "active", activatedAtMs);
      const owner = pool();
      await owner.noteDemand(attached.environmentId);
      await schedule(owner);
      const reserve = reserves()[0]!;
      expect(reserve.preparation).toMatchObject({
        demandAtMs: activatedAtMs,
        expiresAtMs: activatedAtMs + idleWindow,
      });
      expect(provider.notePreparedDemand).toHaveBeenCalledWith(
        { leaseId: attached.leaseId, profile: {} },
        { preparationKey: PREPARATION_KEY, demandAtMs: activatedAtMs },
      );

      nowMs += 60_000;
      store.transition({ environmentId: attached.environmentId, from: "attached", to: "idle" });
      await owner.noteDemand(attached.environmentId);
      await schedule(owner);
      expect(provider.notePreparedDemand).toHaveBeenCalledOnce();
      expect(store.get(reserve.environmentId)?.preparation).toEqual(reserve.preparation);
      nowMs = activatedAtMs + idleWindow;
      await schedule(owner);
      expect(reserves()).toHaveLength(1);
      expect(store.get(reserve.environmentId)?.destroyRequestedAtMs).toBe(nowMs);
    },
  );

  it.each([false, true])(
    "retains slow activation demand when teardown precedes refill (reserve=%s)",
    async (reserve) => {
      const idleWindow = 15 * 60_000;
      provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = ready(seed("slow-activation", { reserve }));
      const activatedAtMs = nowMs + 16 * 60_000;
      const attached = attach(allocated, "active", activatedAtMs);
      nowMs += 60_000;
      teardown(attached);
      reopenStore();

      await schedule(pool());
      const replacement = reserves().filter((record) => record.preparation?.consumedAtMs === null);
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.preparation).toMatchObject({
        demandAtMs: activatedAtMs,
        expiresAtMs: activatedAtMs + idleWindow,
      });
    },
  );

  it("does not allocate when source preparation finishes after its demand deadline", async () => {
    attach(ready(seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    await schedule(
      pool({
        prepareIntent: async () => {
          nowMs = 2_000;
          return {
            providerId: provider.id,
            profileSnapshot: profile(),
            preparationKey: PREPARATION_KEY,
          };
        },
        reconcile,
      }),
    );
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("counts pending and uncertain cleanup against the shared cap after restart", async () => {
    developmentProfile.readyWorkers = 2;
    config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    attach(ready(seed("source-a")));
    attach(ready(seed("source-b", { projectKey: "1".repeat(64) })));
    await schedule(pool());
    const reserved = reserves();
    expect(reserved).toHaveLength(3);
    const uncertain = reserved[0]!;
    store.transition({
      environmentId: uncertain.environmentId,
      from: "requested",
      to: "provisioning",
    });
    store.adoptProvisionCleanupFailure({
      environmentId: uncertain.environmentId,
      leaseId: "uncertain-lease",
      lastError: "provider cleanup response lost",
    });
    reopenStore();
    const warn = vi.fn();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async (record) => {
      if (record.environmentId === uncertain.environmentId) {
        throw new Error("provider cleanup remains unavailable");
      }
    });
    await schedule(pool({ reconcile, warn }));
    expect(
      reserves()
        .map((record) => record.environmentId)
        .toSorted(),
    ).toEqual(reserved.map((record) => record.environmentId).toSorted());
    expect(reconcile.mock.calls.map(([record]) => record.environmentId).toSorted()).toEqual(
      reserved.map((record) => record.environmentId).toSorted(),
    );
    expect(store.get(uncertain.environmentId)).toMatchObject({
      state: "destroying",
      leaseId: "uncertain-lease",
      provisionOperationId: uncertain.provisionOperationId,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retryable"));
  });

  it.each(["profile", "gateway"] as const)(
    "retires excess then disabled %s capacity without touching an attached session",
    async (scope) => {
      developmentProfile.provider = scope === "profile" ? provider.id : " Test-Provider ";
      developmentProfile.readyWorkers = 3;
      const source = attach(ready(seed("source")));
      await schedule(pool());
      expect(reserves()).toHaveLength(3);
      for (const reserve of reserves()) {
        ready(reserve);
      }
      if (scope === "profile") {
        developmentProfile.readyWorkers = 1;
      } else {
        config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      }
      nowMs = 1_100;
      await schedule(pool());
      expect(reserves().filter((record) => record.destroyRequestedAtMs === null)).toHaveLength(1);
      expect(reserves().filter((record) => record.destroyRequestedAtMs === 1_100)).toHaveLength(2);
      if (scope === "profile") {
        developmentProfile.readyWorkers = 0;
      } else {
        config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      }
      nowMs = 1_200;
      await schedule(pool());
      expect(reserves()).toHaveLength(3);
      expect(reserves().every((record) => record.destroyRequestedAtMs !== null)).toBe(true);
      expect(store.get(source.environmentId)).toEqual(source);
    },
  );

  it("retires the previous fingerprint before admitting a new generation in the same project slot", async () => {
    attach(ready(seed("source-old")));
    await schedule(pool());
    const old = reserves()[0]!;
    const nextKey = "2".repeat(64);
    nowMs = 1_100;
    attach(ready(seed("source-new", { preparationKey: nextKey })));
    const owner = pool({
      prepareIntent: async () => ({
        providerId: provider.id,
        profileSnapshot: profile(PROJECT_KEY, nextKey),
        preparationKey: nextKey,
      }),
    });
    await schedule(owner);
    expect(reserves()).toHaveLength(1);
    expect(store.get(old.environmentId)?.destroyRequestedAtMs).toBe(1_100);
    // This intent never allocated; the ordinary lifecycle can terminalize it safely.
    store.transition({ environmentId: old.environmentId, from: "requested", to: "failed" });
    await schedule(owner);
    expect(reserves().filter((record) => record.state === "requested")).toEqual([
      expect.objectContaining({
        preparation: {
          key: nextKey,
          demandAtMs: 1_100,
          expiresAtMs: 2_100,
          consumedAtMs: null,
        },
      }),
    ]);
  });

  it("revalidates an earlier source when another awaited preparation changes admission authority", async () => {
    attach(ready(seed("source-a")));
    attach(ready(seed("source-b", { projectKey: "1".repeat(64) })));
    let generation = 0;
    let admittedAtHasFirst = false;
    const admittedAt = new WeakMap<WorkerProviderPreparedIntent, number>();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({
      prepareIntent: async (_profileId, { projectPath }) => {
        if (admittedAtHasFirst) {
          generation += 1;
        }
        admittedAtHasFirst = true;
        const intent = {
          providerId: provider.id,
          profileSnapshot: profile(path.basename(projectPath)),
          preparationKey: PREPARATION_KEY,
        };
        admittedAt.set(intent, generation);
        return intent;
      },
      assertIntentCurrent: (_profileId, intent) => {
        if (admittedAt.get(intent) !== generation) {
          throw new Error("preparation authority changed");
        }
      },
      reconcile,
    });
    await expect(schedule(owner)).rejects.toThrow("preparation authority changed");
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs only two preparations concurrently and drains admitted work after shutdown", async () => {
    developmentProfile.readyWorkers = 3;
    attach(ready(seed("source")));
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const reconcile = vi.fn(async (_record: WorkerEnvironmentRecord, signal: AbortSignal) => {
      if (reconcile.mock.calls.length === 2) {
        entered.resolve();
      }
      await release.promise;
      expect(signal.aborted).toBe(true);
    });
    const owner = pool({ reconcile });
    let settled = false;
    const running = schedule(owner).then(() => {
      settled = true;
    });
    await entered.promise;
    expect(reserves()).toHaveLength(3);
    expect(reconcile).toHaveBeenCalledTimes(2);
    abort.abort();
    await owner.schedule();
    expect(settled).toBe(false);
    release.resolve();
    await running;
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reserves().every((record) => record.state === "requested")).toBe(true);
  });

  it("retires queued capacity when disabled before its reconciliation lock is acquired", async () => {
    const reserve = seed("queued-reserve", { reserve: true });
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const provision = vi.fn();
    const cleanup = vi.fn();
    const owner = pool({
      reconcile: async (record, _signal, beforeReconcile) => {
        entered.resolve();
        await release.promise;
        // The runtime repeats this callback after acquiring its environment lock.
        beforeReconcile();
        const current = store.get(record.environmentId)!;
        if (current.destroyRequestedAtMs === null) {
          provision(current);
        } else {
          cleanup(current);
        }
      },
    });
    const running = schedule(owner);
    await entered.promise;
    expect(store.get(reserve.environmentId)?.destroyRequestedAtMs).toBeNull();
    developmentProfile.readyWorkers = 0;
    release.resolve();
    await running;
    expect(provision).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: reserve.environmentId,
        destroyRequestedAtMs: nowMs,
      }),
    );
    expect(reserves()).toHaveLength(1);
  });

  it.each([
    ["unchanged intent", false, undefined],
    ["changed intent", true, undefined],
    ["project active", false, "project"],
    ["project cleanup", true, "project"],
    ["global active", false, "global"],
    ["global cleanup", true, "global"],
    ["previous provider active", false, "provider"],
    ["previous provider cleanup", true, "provider"],
    ["later global active", false, "later-global"],
    ["later global cleanup", true, "later-global"],
  ] as const)(
    "rechecks reserve intent and capacity after the provider queue (%s)",
    async (_scenario, changed, cleanupScope) => {
      let previous: WorkerEnvironmentRecord | undefined;
      if (cleanupScope === "later-global") {
        config.cloudWorkers!.preparedPool = { maxTotal: 1 };
        attach(ready(seed("current-source")));
      } else if (cleanupScope) {
        const consumed =
          cleanupScope === "global"
            ? store.createIntent({
                environmentId: "previous-global-worker",
                providerId: provider.id,
                profileId: "removed-profile",
                provisionOperationId: "previous-global-operation",
                profileSnapshot: profile("1".repeat(64)),
                preparation: {
                  key: PREPARATION_KEY,
                  demandAtMs: nowMs,
                  expiresAtMs: nowMs + IDLE_TIMEOUT_MS,
                },
              })
            : seed("previous-worker", { reserve: true });
        previous = attach(ready(consumed));
        nowMs += 100;
        if (cleanupScope === "global") {
          config.cloudWorkers!.preparedPool = { maxTotal: 1 };
        } else if (cleanupScope === "provider") {
          provider = { ...provider, id: "replacement-provider" };
          developmentProfile.provider = provider.id;
        }
        if (cleanupScope !== "project") {
          attach(ready(seed("current-source")));
        }
      } else {
        const reserve = seed("queued-provider-reserve", { reserve: true });
        store.transition({
          environmentId: reserve.environmentId,
          from: "requested",
          to: "provisioning",
        });
      }
      const entered = createDeferred();
      const release = createDeferred();
      releases.push(() => release.resolve());
      let intentChanged = false;
      const callProvider = async <T>(_environmentId: string, run: () => Promise<T>): Promise<T> => {
        entered.resolve();
        await release.promise;
        return await run();
      };
      const unexpectedLifecycleOperation = (): never => {
        throw new Error("unexpected worker bootstrap or teardown past the allocation boundary");
      };
      const move: Parameters<typeof createWorkerProviderProvisioner>[0]["move"] = (
        record,
        to,
        patch,
      ) =>
        store.transition({
          environmentId: record.environmentId,
          from: record.state,
          expectedOwnerEpoch: record.ownerEpoch,
          to,
          patch,
        });
      const lifecycleOptions = {
        store,
        callProvider,
        move,
        saveError: (record, error) =>
          store.recordError({
            environmentId: record.environmentId,
            state: record.state,
            error: String(error),
          }),
        // This fixture borrows only requireCurrentOwner; unexpected teardown must fail visibly.
        withLock: unexpectedLifecycleOperation,
        providerFor: (providerId) => {
          if (providerId !== provider.id) {
            throw createWorkerEnvironmentServiceError(
              "provider_not_found",
              `Worker provider is unavailable: ${providerId}`,
            );
          }
          return provider;
        },
        requireWorkerProfile: () => ({}),
        serviceError: createWorkerEnvironmentServiceError,
        isStopping: () => false,
        inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) =>
          states.includes(record.state),
      } satisfies Parameters<typeof createWorkerProviderOwnerLifecycle>[0];
      const { requireCurrentOwner } = createWorkerProviderOwnerLifecycle(lifecycleOptions);
      const prepareInstallation = async () => ({
        install: "bundle" as const,
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "f".repeat(64),
        tarballPath: path.join(root, "unused.tgz"),
      });
      const provision = createWorkerProviderProvisioner({
        ...lifecycleOptions,
        now: () => nowMs,
        projectNamespace: "gateway",
        prepareInstallation,
        nodeProvisioning: createWorkerNodeProvisioning({
          ...lifecycleOptions,
          prepareInstallation,
          commitReady: unexpectedLifecycleOperation,
          failBootstrap: unexpectedLifecycleOperation,
        }),
        requireCurrentOwner,
        installFor: () => "bundle",
        finishBootstrap: unexpectedLifecycleOperation,
        failBootstrap: unexpectedLifecycleOperation,
        isServiceError: (error, code) =>
          error instanceof WorkerEnvironmentServiceError && error.code === code,
      });
      provider.supportedExecutionModes = ["worker-turn"];
      provider.supportsProjectPreparation = () => true;
      provider.resolvePreparationTarget = () => ({
        machineClass: "standard",
        platform: "linux",
        arch: "x64",
      });
      provider.provision = vi.fn(async () => {
        throw new Error("allocation boundary reached");
      });
      const owner = pool({
        assertIntentCurrent: () => {
          if (intentChanged) {
            throw createWorkerEnvironmentServiceError(
              "invalid_profile",
              "Worker profile changed during preparation",
            );
          }
        },
        reconcile: async (record, _signal, beforeReconcile) => {
          await provision(record, provider, undefined, undefined, beforeReconcile);
        },
      });
      const running = schedule(owner);
      await Promise.race([entered.promise, running]);
      expect(provider.provision).not.toHaveBeenCalled();
      const pending = reserves().filter((record) => record.preparation?.consumedAtMs === null);
      expect(pending).toHaveLength(1);
      const reserve = pending[0]!;
      expect(reserve).toMatchObject({
        state: cleanupScope ? "requested" : "provisioning",
        destroyRequestedAtMs: null,
      });
      if (cleanupScope === "later-global") {
        nowMs += 100;
        config.cloudWorkers!.preparedPool = { maxTotal: 2 };
        const admitted = store.ensurePreparedIntent({
          intent: {
            environmentId: "later-global-worker",
            providerId: provider.id,
            profileId: "other-profile",
            provisionOperationId: "later-global-operation",
            profileSnapshot: profile("1".repeat(64)),
            preparation: {
              key: PREPARATION_KEY,
              demandAtMs: nowMs,
              expiresAtMs: nowMs + IDLE_TIMEOUT_MS,
            },
          },
          projectKey: "1".repeat(64),
          target: 1,
          maxTotal: config.cloudWorkers!.preparedPool.maxTotal!,
          assertCurrent: () => {},
        });
        expect(admitted).toBeDefined();
        previous = attach(ready(admitted!));
        expect(previous.createdAtMs).toBeGreaterThan(reserve.createdAtMs);
        config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      }
      if (cleanupScope && previous) {
        if (changed) {
          store.requestDestroy({ environmentId: previous.environmentId, state: previous.state });
        }
      } else {
        intentChanged = changed;
      }
      release.resolve();
      await running;
      expect(provider.provision).toHaveBeenCalledTimes(changed ? 0 : 1);
      expect(store.get(reserve.environmentId)).toMatchObject({
        state: changed && cleanupScope ? "requested" : "provisioning",
        leaseId: null,
        provisionOperationId: reserve.provisionOperationId,
        destroyRequestedAtMs: changed ? nowMs : null,
      });
      if (previous) {
        expect(store.get(previous.environmentId)).toMatchObject({
          state: "attached",
          leaseId: previous.leaseId,
          preparation: previous.preparation,
          destroyRequestedAtMs: changed ? nowMs : null,
        });
      }
    },
  );

  it("keeps actual service reserve cleanup outside the installed placement fence while stop drains it", async () => {
    const reserve = ready(seed("expired", { reserve: true }));
    nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    provider.destroy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      prepareInstallation: async () => ({
        install: "bundle",
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "e".repeat(64),
        tarballPath: path.join(root, "unused.tgz"),
      }),
      bootstrapWorker: async () => RECEIPT,
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => nowMs,
    });
    const guard = vi.fn<
      Parameters<WorkerEnvironmentService["installReconcileEnvironmentGuard"]>[0]
    >(async (_environmentId, reconcile) => {
      await reconcile();
    });
    service.installReconcileEnvironmentGuard(guard);
    await service.reconcileOnce();
    await entered.promise;
    expect(guard).not.toHaveBeenCalled();
    expect(provider.provision).not.toHaveBeenCalled();
    expect(provider.inspect).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await service.reconcileOnce();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(store.get(reserve.environmentId)?.state).toBe("destroyed");
    expect(provider.destroy).toHaveBeenCalledOnce();
  });
});
