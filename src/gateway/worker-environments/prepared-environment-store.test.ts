import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import type {
  PreparedEnvironmentSelection,
  WorkerEnvironmentIntentInput,
} from "./environment-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerEnvironmentStore } from "./store.js";

const PROJECT_KEY = "a".repeat(64);
const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
const assertCurrent = () => undefined;

// These exercise the shared database, since process-local exclusion cannot protect
// a consumed machine after placement retirement or a second store opens the file.
describe("prepared environment ownership", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let environments: ReturnType<typeof createWorkerEnvironmentStore>;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  let nowMs: number;

  const openStores = () => {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    environments = createWorkerEnvironmentStore({ database, now: () => nowMs });
    placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-prepared-"));
    nowMs = 1_000;
    openStores();
  });
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function intent(environmentId = "prepared-1", key = PREPARATION_KEY) {
    return {
      environmentId,
      providerId: "test-provider",
      profileId: "test-profile",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: {
        settings: {},
        executionMode: "worker-turn",
        project: { key: PROJECT_KEY, root: "/project", baseCommit: "d".repeat(40) },
      },
      preparation: { key, demandAtMs: 900, expiresAtMs: 2_000 },
    } satisfies WorkerEnvironmentIntentInput;
  }
  function reserve(
    environmentId = "prepared-1",
    key = PREPARATION_KEY,
    maxTotal = 4,
    providerId = "test-provider",
  ) {
    return environments.ensurePreparedIntent({
      intent: { ...intent(environmentId, key), providerId },
      projectKey: PROJECT_KEY,
      target: 1,
      maxTotal,
      assertCurrent,
    });
  }
  function ready() {
    reserve();
    environments.transition({ environmentId: "prepared-1", from: "requested", to: "provisioning" });
    return environments.transition({
      environmentId: "prepared-1",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "lease-1",
        nodeDeviceId: "node-1",
        sharedHost: false,
        bootstrapReceipt: {
          bundleHash: BUNDLE_HASH,
          openclawVersion: "2026.8.1",
          protocolFeatures: [],
        },
        credential: {
          credentialHash: hashWorkerCredential("ready-credential"),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 10_000,
        },
      },
    });
  }
  function selection(sessionId = "session-1"): PreparedEnvironmentSelection {
    const identity = {
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      agentId: "main",
      executionMode: "worker-turn" as const,
    };
    const placement = placements.startDispatch(identity);
    return {
      ...identity,
      expectedGeneration: placement.generation,
      environmentId: "prepared-1",
      ownerEpoch: 1,
      providerId: "test-provider",
      profileId: "test-profile",
      preparationKey: PREPARATION_KEY,
      nodeDeviceId: "node-1",
      leaseId: "lease-1",
      bundleHash: BUNDLE_HASH,
      assertCurrent,
    };
  }
  function expiry() {
    return environments.requestPreparedDestroy({
      environmentId: "prepared-1",
      ownerEpoch: 1,
      preparationKey: PREPARATION_KEY,
      reason: "expired",
      assertCurrent,
    });
  }

  it("assigns once across store instances and retains consumption after placement deletion and reopen", () => {
    ready();
    const first = selection();
    const second = selection("session-2");
    const assigned = placements.bindPreparedEnvironment(first)!;
    expect(assigned).toMatchObject({ state: "provisioning", environmentId: "prepared-1" });
    const anotherStore = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    expect(anotherStore.bindPreparedEnvironment(second)).toBeUndefined();
    const failed = placements.fail({
      sessionId: first.sessionId,
      expectedGeneration: assigned.generation,
      recoveryError: "assignment cancelled",
    });
    placements.retireSessionPlacement({
      sessionId: first.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    closeOpenClawStateDatabaseForTest();
    openStores();
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBe(1_000);
    expect(placements.bindPreparedEnvironment(second)).toBeUndefined();
    expect(placements.get(second.sessionId)?.state).toBe("requested");
  });

  it.each(["claim-first", "expire-first"] as const)(
    "excludes claim and expiry in %s order",
    (order) => {
      ready();
      const request = selection();
      if (order === "claim-first") {
        expect(placements.bindPreparedEnvironment(request)?.state).toBe("provisioning");
        nowMs = 2_000;
        expect(expiry()).toBeUndefined();
        expect(environments.get("prepared-1")?.destroyRequestedAtMs).toBeNull();
      } else {
        nowMs = 2_000;
        expect(expiry()?.destroyRequestedAtMs).toBe(2_000);
        expect(placements.bindPreparedEnvironment(request)).toBeUndefined();
        expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
      }
    },
  );

  it.each(["test-provider", "replacement-provider"])(
    "keeps an old generation and uncertain cleanup inside project capacity for %s",
    (providerId) => {
      reserve();
      expect(reserve("prepared-2", "e".repeat(64), 4, providerId)).toBeUndefined();
      expect(
        environments.requestPreparedDestroy({
          environmentId: "prepared-1",
          ownerEpoch: 0,
          preparationKey: PREPARATION_KEY,
          reason: "invalidated",
          assertCurrent,
        })?.destroyRequestedAtMs,
      ).toBe(1_000);
      expect(reserve("prepared-2", "e".repeat(64), 4, providerId)).toBeUndefined();
      environments.transition({ environmentId: "prepared-1", from: "requested", to: "failed" });
      expect(reserve("prepared-2", "e".repeat(64), 4, providerId)?.state).toBe("requested");
    },
  );

  it.each(["test-provider", "replacement-provider"])(
    "counts consumed workers awaiting cleanup against the reserve cap for %s",
    (providerId) => {
      ready();
      placements.bindPreparedEnvironment(selection());
      environments.requestDestroy({ environmentId: "prepared-1", state: "ready" });
      expect(reserve("prepared-2", PREPARATION_KEY, 4, providerId)).toBeUndefined();
    },
  );

  it("enforces the global cap, zero capacity, expiry and immutable intent replay", () => {
    expect(reserve("disabled", PREPARATION_KEY, 0)).toBeUndefined();
    const original = reserve();
    expect(reserve()).toEqual(original);
    expect(() => reserve("prepared-1", "e".repeat(64))).toThrow("identity changed");
    expect(
      environments.ensurePreparedIntent({
        intent: { ...intent("other"), profileId: "other-profile" },
        projectKey: PROJECT_KEY,
        target: 1,
        maxTotal: 1,
        assertCurrent,
      }),
    ).toBeUndefined();
    nowMs = 2_000;
    expect(reserve("expired", PREPARATION_KEY, 4)).toBeUndefined();
  });

  it.each([
    { ownerEpoch: 2 },
    { preparationKey: "e".repeat(64) },
    { leaseId: "replacement" },
    { nodeDeviceId: "replacement" },
    { bundleHash: "e".repeat(64) },
    { profileId: "other" },
    { sessionKey: "agent:main:other" },
    { expectedGeneration: 999 },
  ])("rejects stale selection without consuming capacity: %j", (changed) => {
    ready();
    const request = selection();
    expect(placements.bindPreparedEnvironment({ ...request, ...changed })).toBeUndefined();
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
    expect(placements.get(request.sessionId)?.state).toBe("requested");
  });

  it("rechecks live authority before consuming and atomically rolls back a rejected assignment", () => {
    ready();
    const request = selection();
    let assertions = 0;
    expect(() =>
      placements.bindPreparedEnvironment({
        ...request,
        assertCurrent: () => {
          if (++assertions === 2) {
            throw new Error("caller revoked");
          }
        },
      }),
    ).toThrow("caller revoked");
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
    expect(placements.get(request.sessionId)?.state).toBe("requested");
  });

  it.each(["immediate", "after reserve expiry"] as const)(
    "requires the exact reservation for %s attachment and cannot recycle its rollback",
    (timing) => {
      ready();
      const request = selection();
      const assigned = placements.bindPreparedEnvironment(request)!;
      if (timing === "after reserve expiry") {
        nowMs = 2_001;
        closeOpenClawStateDatabaseForTest();
        openStores();
      }
      const syncing = placements.transition({
        sessionId: request.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: assigned.generation,
        patch: { workerBundleHash: BUNDLE_HASH },
      });
      const attach = {
        environmentId: "prepared-1",
        from: "ready" as const,
        to: "attached" as const,
        expectedOwnerEpoch: 1,
        patch: {
          attachedSessionIds: [request.sessionId],
          credential: {
            credentialHash: hashWorkerCredential("attached-credential"),
            sessionId: request.sessionId,
            rpcSetVersion: 1,
            expiresAtMs: 10_000,
          },
        },
      };
      expect(() => environments.transition(attach)).toThrow("exact placement reservation");
      const binding = { ...request, generation: syncing.generation };
      expect(() =>
        environments.transition({ ...attach, placementBinding: { ...binding, generation: 0 } }),
      ).toThrow("exact placement reservation");
      const attached = environments.transition({ ...attach, placementBinding: binding });
      expect(attached.state).toBe("attached");
      const idle = environments.transition({
        environmentId: "prepared-1",
        from: "attached",
        to: "idle",
      });
      expect(idle.preparation?.consumedAtMs).toBe(1_000);
      expect(() =>
        environments.transition({
          ...attach,
          from: "idle",
          expectedOwnerEpoch: idle.ownerEpoch,
          placementBinding: binding,
        }),
      ).toThrow("exact placement reservation");
    },
  );
});
