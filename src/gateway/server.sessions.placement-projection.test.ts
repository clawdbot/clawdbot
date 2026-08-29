import { expect, test, vi } from "vitest";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerPlacementMoveIntent } from "./worker-environments/placement-move-intent.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    sessionId: "sess-main",
    agentId: "main",
    sessionKey: "agent:main:main",
    executionMode: "worker-turn",
    state: "active",
    environmentId: "env-placement",
    generation: 7,
    activeOwnerEpoch: 12,
    workspaceBaseManifestRef: "manifest-base",
    remoteWorkspaceDir: "/workspace/main",
    workerBundleHash: ["a", "b"].join("").repeat(32),
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 100,
    updatedAtMs: 300,
    stateChangedAtMs: 200,
  };
}

async function seedSessionRows(): Promise<void> {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: 200 },
      "agent:main:other": { sessionId: "sess-other", updatedAt: 100 },
    },
  });
}

test("sessions.list omits placement when the worker placement service is disabled", async () => {
  await seedSessionRows();

  const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>("sessions.list", {});

  expect(result.ok).toBe(true);
  expect(result.payload?.sessions).toHaveLength(2);
  expect(result.payload?.sessions.every((session) => session.placement === undefined)).toBe(true);
});

test.each([true, false])(
  "sessions.list batch-projects durable worker placement (environment exists: %s)",
  async (environmentExists) => {
    await seedSessionRows();
    const placement = activePlacementRecord();
    const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
      expect(sessionIds).toEqual(expect.arrayContaining(["sess-main", "sess-other"]));
      return new Map([[placement.sessionId, placement]]);
    });
    const diskSpace = {
      status: "warning" as const,
      availableBytes: 400,
      totalBytes: 1_000,
      observedAtMs: 350,
    };
    const identity = { providerId: "machine0", profileId: "team" };
    const getEnvironment = vi.fn((environmentId: string) =>
      environmentExists && environmentId === placement.environmentId ? identity : undefined,
    );
    const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
      "sessions.list",
      {},
      {
        context: {
          workerSessionPlacementService: { getMany },
          workerEnvironmentService: { get: getEnvironment },
          workerPlacementDiskSpaceReader: { read: () => diskSpace, version: () => 1 },
          workerPlacementRunnerAvailabilityReader: {
            read: () => ({ kind: "device", status: "offline" }),
            version: () => 1,
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(getMany).toHaveBeenCalledTimes(1);
    const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
    const other = result.payload?.sessions.find((session) => session.sessionId === "sess-other");
    expect(main?.placement).toStrictEqual({
      state: "active",
      environmentId: "env-placement",
      generation: 7,
      activeOwnerEpoch: 12,
      workspaceBaseManifestRef: "manifest-base",
      remoteWorkspaceDir: "/workspace/main",
      workerBundleHash: ["a", "b"].join("").repeat(32),
      lastTranscriptAckCursor: 23,
      lastLiveEventAckCursor: 9,
      createdAtMs: 100,
      updatedAtMs: 300,
      stateChangedAtMs: 200,
      diskSpace,
      runner: { kind: "device", status: "offline" },
      ...(environmentExists ? identity : {}),
    });
    expect(other?.placement).toBeUndefined();
  },
);

test("sessions.list projects durable placement move progress", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const move: WorkerPlacementMoveIntent = {
    operationId: "move:v1:opaque",
    sessionId: placement.sessionId,
    source: {
      generation: placement.generation,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    },
    target: { kind: "gateway" },
    abandonSource: false,
    lastError: "workspace reconciliation is waiting",
    createdAtMs: 320,
    updatedAtMs: 340,
  };
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>(
    () => new Map([[placement.sessionId, placement]]),
  );
  const getPlacementMoves = vi.fn<NonNullable<WorkerSessionPlacementReader["getPlacementMoves"]>>(
    () => new Map([[move.sessionId, move]]),
  );

  const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    { context: { workerSessionPlacementService: { getMany, getPlacementMoves } } },
  );

  expect(result.ok).toBe(true);
  const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
  expect(main?.placementMove).toEqual({
    target: { kind: "gateway" },
    error: "workspace reconciliation is waiting",
    updatedAtMs: 340,
  });
  expect(main?.placementMove).not.toHaveProperty("operationId");
  expect(getPlacementMoves).toHaveBeenCalledOnce();
});

test("sessions.describe projects durable worker placement", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
    expect(sessionIds).toEqual(["sess-main"]);
    return new Map([[placement.sessionId, placement]]);
  });
  const diskSpace = {
    status: "critical" as const,
    availableBytes: 50,
    totalBytes: 1_000,
    observedAtMs: 350,
  };

  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key: "main" },
    {
      context: {
        workerSessionPlacementService: { getMany },
        workerPlacementDiskSpaceReader: { read: () => diskSpace, version: () => 1 },
        workerPlacementRunnerAvailabilityReader: {
          read: () => ({ kind: "device", status: "offline" }),
          version: () => 1,
        },
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(result.payload?.session?.placement).toEqual({
    state: "active",
    environmentId: "env-placement",
    generation: 7,
    activeOwnerEpoch: 12,
    workspaceBaseManifestRef: "manifest-base",
    remoteWorkspaceDir: "/workspace/main",
    workerBundleHash: ["a", "b"].join("").repeat(32),
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
    createdAtMs: 100,
    updatedAtMs: 300,
    stateChangedAtMs: 200,
    diskSpace,
    runner: { kind: "device", status: "offline" },
  });
});

test("sessions.describe projects a durable per-session terminal reason without environment lookup", async () => {
  await seedSessionRows();
  const active = activePlacementRecord();
  const placement = {
    ...active,
    state: "failed" as const,
    turnClaim: null,
    recoveryError: "cloud worker disappeared: provider reported lease destroyed",
    terminalReason: "cloud worker disappeared: provider reported lease destroyed",
    terminalAtMs: 400,
  } satisfies WorkerSessionPlacementRecord;
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>(
    () => new Map([[placement.sessionId, placement]]),
  );

  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key: "main" },
    { context: { workerSessionPlacementService: { getMany } } },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.session?.placement).toMatchObject({
    state: "failed",
    terminalReason: "cloud worker disappeared: provider reported lease destroyed",
    terminalAtMs: 400,
  });
});
