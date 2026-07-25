import { expect, test, vi } from "vitest";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

function activePlacementRecord(): WorkerSessionPlacementRecord {
  return {
    sessionId: "sess-main",
    agentId: "main",
    sessionKey: "agent:main:main",
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

test("sessions.list batch-projects durable worker placement", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
    expect(sessionIds).toEqual(expect.arrayContaining(["sess-main", "sess-other"]));
    return new Map([[placement.sessionId, placement]]);
  });

  const result = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    {
      context: { workerSessionPlacementService: { getMany } },
    },
  );

  expect(result.ok).toBe(true);
  expect(getMany).toHaveBeenCalledTimes(1);
  const main = result.payload?.sessions.find((session) => session.sessionId === "sess-main");
  const other = result.payload?.sessions.find((session) => session.sessionId === "sess-other");
  expect(main?.placement).toEqual({
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
  });
  expect(other?.placement).toBeUndefined();
});

test("sessions.describe projects durable worker placement", async () => {
  await seedSessionRows();
  const placement = activePlacementRecord();
  const getMany = vi.fn<WorkerSessionPlacementReader["getMany"]>((sessionIds) => {
    expect(sessionIds).toEqual(["sess-main"]);
    return new Map([[placement.sessionId, placement]]);
  });

  const result = await directSessionReq<{ session: GatewaySessionRow | null }>(
    "sessions.describe",
    { key: "main" },
    {
      context: { workerSessionPlacementService: { getMany } },
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
  });
});
