import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("repairs duplicate session owners", async () => {
    const sessionId = "legacy";
    const older = support.seedAttachedIdentity("legacy-a", sessionId);
    const newer = support.seedAttachedIdentity("legacy-b", "other");
    support.testState.stateDb.db.exec(`
      UPDATE worker_environments SET attached_session_ids_json = '["legacy"]'
        WHERE environment_id = 'legacy-b';
      UPDATE worker_environment_credentials SET session_id = 'legacy'
        WHERE environment_id = 'legacy-b';
    `);

    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const liveEvents = support.createLiveEvents();
    const workerService = support.createService(support.createProvider(), { liveEvents });
    const event = { ...support.LIVE_EVENT, runEpoch: newer.ownerEpoch };
    await expect(workerService.pushLiveEvent(older, event)).resolves.toEqual({
      ok: false,
      closeReason: "credential-replaced",
    });
    await workerService.pushLiveEvent({ ...newer, sessionId }, event);
    expect(liveEvents.apply).toHaveBeenCalledOnce();
  });

  it("rejects attach before current bootstrap", async () => {
    const staleId = "worker-stale-attach";
    const bootstrapping = support.seedBootstrapping(staleId);
    support.testState.store.transition({
      environmentId: staleId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(staleId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "c".repeat(64),
      }),
    });
    const workerService = support.createService(support.createProvider());

    await expect(
      workerService.attachSession({
        environmentId: staleId,
        ownerEpoch: 1,
        sessionId: "session-1",
      }),
    ).rejects.toThrow(STALE_WORKER_BUILD_REASON);
    expect(support.testState.store.get(staleId)).toMatchObject({
      state: "ready",
      attachedSessionIds: [],
    });
  });

  it("returns a bounded error when another worker owns the session", async () => {
    const firstId = "worker-session-owner";
    const secondId = "worker-session-contender";
    support.seedReady(firstId);
    support.seedReady(secondId);
    const workerService = support.createService(support.createProvider());

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
    expect(support.testState.store.get(secondId)).toMatchObject({
      state: "ready",
      attachedSessionIds: [],
    });
  });

  it("requires session reclaim before operator destruction of an attached worker", async () => {
    const environmentId = "worker-session-reclaim";
    support.seedReady(environmentId);
    const workerService = support.createService(support.createProvider());
    await workerService.attachSession({
      environmentId,
      ownerEpoch: 1,
      sessionId: "session-reclaim",
    });

    await expect(workerService.destroyUnattached(environmentId)).rejects.toMatchObject({
      code: "invalid_state",
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-reclaim"],
    });
  });

  it("stops the tunnel after live binding rollback", async () => {
    const environmentId = "live-bind-fail";
    support.seedReady(environmentId);
    const liveEvents = support.createLiveEvents({
      bindSession: vi.fn(() => {
        throw new Error("bind failed");
      }),
    });
    const tunnelManager = {
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), {
      liveEvents,
      tunnelManager,
    });

    await expect(
      workerService.attachSession({ environmentId, ownerEpoch: 1, sessionId: "session-live" }),
    ).rejects.toThrow("Attached session target is unavailable");
    expect(tunnelManager.stop).toHaveBeenCalledWith(environmentId, 1);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "idle",
      attachedSessionIds: [],
    });
  });

  it("renews in place and binds delivery acknowledgement to the exact grant", async () => {
    const environmentId = "worker-credential-replacement";
    support.seedReady(environmentId);
    let credentialSequence = 0;
    const workerService = support.createService(support.createProvider(), {
      generateWorkerCredential: () => [support.CREDENTIAL, String(++credentialSequence)].join("-"),
      workerCredentialTtlMs: 100,
    });

    const binding = { environmentId, ownerEpoch: 1, sessionId: null };
    await workerService.reconcileOnce();
    const previous = workerService.takeMintedCredential(binding)!;
    support.testState.nowMs += 100;
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    await workerService.reconcileOnce();
    const renewal = workerService.takeMintedCredential(binding)!;
    expect(renewal).toMatchObject({ ownerEpoch: 1, sessionId: null });
    expect(support.testState.store.get(environmentId)?.ownerEpoch).toBe(1);
    expect(workerService.acknowledgeCredentialDelivery(previous)).toBe(false);
    expect(workerService.takeMintedCredential(binding)).toMatchObject({
      deliveryId: renewal.deliveryId,
    });
    expect(workerService.acknowledgeCredentialDelivery(renewal)).toBe(true);
  });

  it("recovers an undelivered atomic session credential after restart without changing owner", async () => {
    const environmentId = "worker-attach-restart";
    support.seedReady(environmentId);
    let credentialSequence = 0;
    const stopTunnel = vi.fn(async () => {
      throw new Error("tunnel stop interrupted");
    });
    const tunnelManager = {
      start: vi.fn(),
      stop: stopTunnel,
      stopAll: vi.fn(async () => {}),
      status: () => "stopped" as const,
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
    } as unknown as WorkerTunnelManager;
    const options = {
      generateWorkerCredential: () => [support.CREDENTIAL, String(++credentialSequence)].join("-"),
      tunnelManager,
    };
    const first = support.createService(support.createProvider(), options);
    await first.reconcileOnce();
    await expect(
      first.attachSession({ environmentId, ownerEpoch: 1, sessionId: "session-1" }),
    ).rejects.toThrow("tunnel stop interrupted");
    const binding = { environmentId, ownerEpoch: 2, sessionId: "session-1" };
    const lostHash = support.testState.store.getCredential(environmentId)?.credentialHash;

    expect(stopTunnel).toHaveBeenCalledWith(environmentId, 1);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      ownerEpoch: 2,
    });
    expect(first.takeMintedCredential(binding)).toBeUndefined();

    await first.stop();
    const restarted = support.createService(support.createProvider(), options);
    await restarted.reconcileOnce();

    const recovered = restarted.takeMintedCredential(binding);
    expect(recovered?.deliveryId).not.toBe(lostHash);
    expect(restarted.acknowledgeCredentialDelivery(recovered!)).toBe(true);
    const deliveredHash = support.testState.store.getCredential(environmentId)?.credentialHash;

    await restarted.stop();
    const deliveredRestart = support.createService(support.createProvider(), options);
    await deliveredRestart.reconcileOnce();
    expect(deliveredRestart.takeMintedCredential(binding)).toBeUndefined();
    expect(support.testState.store.getCredential(environmentId)?.credentialHash).toBe(
      deliveredHash,
    );
  });
});
