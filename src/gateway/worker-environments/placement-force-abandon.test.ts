import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

describe("forced worker environment abandonment", () => {
  let root: string;
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-worker-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records result loss and releases a pending worker claim before teardown", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "forced-claim",
      runId: "forced-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    store.markWorkspaceResultPending(claim);

    await forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => root,
    });

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("releases a pending worker claim when its workspace is already gone", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "forced-missing-workspace-claim",
      runId: "forced-missing-workspace-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    store.markWorkspaceResultPending(claim);
    store.recordStagedWorkspaceResult(
      claim,
      "refs/openclaw/worker-results/forced-missing-workspace-claim",
    );

    await forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => {
        throw new Error("session-owned managed worktree is missing");
      },
    });

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("deletes a stale journal without replaying it into the current workspace", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "b".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"c".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("draining placement fixture was not draining");
    }
    store.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const resolveWorkspacePath = vi.fn(async () => root);

    await forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath,
    });

    expect(resolveWorkspacePath).not.toHaveBeenCalled();
    expect(store.listWorkspaceReconciliationOwners()).toEqual([]);
    expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
  });

  it("retains a current journal when its best-effort rollback fails", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "c".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"d".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    const onCleanupError = vi.fn();

    const resolveWorkspacePath = vi.fn(async () => {
      throw new Error("workspace temporarily unavailable");
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await forceAbandonWorkerEnvironment({
        placements: store,
        environmentId,
        resolveWorkspacePath,
        onCleanupError,
      });
    }

    expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(resolveWorkspacePath).toHaveBeenCalledTimes(2);
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "workspace temporarily unavailable" }),
    );
  });

  it("retains a current journal when loading it fails", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "d".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"e".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    const onCleanupError = vi.fn();
    vi.spyOn(store, "loadWorkspaceReconciliation").mockImplementation(() => {
      throw new Error("journal temporarily unreadable");
    });

    const resolveWorkspacePath = vi.fn(async () => root);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await forceAbandonWorkerEnvironment({
        placements: store,
        environmentId,
        resolveWorkspacePath,
        onCleanupError,
      });
    }

    expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(resolveWorkspacePath).not.toHaveBeenCalled();
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "journal temporarily unreadable" }),
    );
  });
});
