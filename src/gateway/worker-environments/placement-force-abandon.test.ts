import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createGatewayWorkerPlacementRuntime } from "../server-worker-placement-startup.js";
import {
  createDispatchEnvironmentFixtures,
  FORCED_WORKER_ABANDONMENT_ERROR,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  cleanupWorkerWorkspaceResultRef,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const effects = vi.hoisted(() => ({
  workerPlacementError: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-placement"
        ? { ...logger, error: effects.workerPlacementError }
        : logger;
    },
  };
});

describe("forced worker environment abandonment", () => {
  let root: string;
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    effects.workerPlacementError.mockClear();
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-worker-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("drains nested operations before recording result loss and releasing the claim", async () => {
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
    const closed = vi.fn();
    const unregister = store.registerTurnClaimClosedHandler(closed);
    store.markWorkspaceResultPending(claim);
    const binding = {
      sessionId: claim.sessionId,
      environmentId,
      ownerEpoch: 2,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "forced-send",
        requestDigest: "forced-send-digest",
      }),
    ).toMatchObject({ kind: "execute" });

    const abandonment = forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => root,
    });

    await vi.waitFor(() => {
      expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "forced-send",
        requestDigest: "forced-send-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await abandonment;

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith(claim);
    unregister();
  });

  it("drains nested operations before forced teardown without a pending result", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "forced-operation-claim",
      runId: "forced-operation-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    const binding = {
      sessionId: claim.sessionId,
      environmentId,
      ownerEpoch: 2,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "forced-operation-send",
        requestDigest: "forced-operation-digest",
      }),
    ).toMatchObject({ kind: "execute" });

    const abandonment = forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => root,
    });

    await vi.waitFor(() => {
      expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "forced-operation-send",
        requestDigest: "forced-operation-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await abandonment;

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
  });

  it("atomically abandons a terminal result ACKed while nested operations drain", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "forced-racing-result-claim",
      runId: "forced-racing-result-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    const closed = vi.fn();
    const unregister = store.registerTurnClaimClosedHandler(closed);
    const binding = {
      sessionId: claim.sessionId,
      environmentId,
      ownerEpoch: 2,
      runId: claim.runId,
    };
    store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      store.beginWorkerSessionToolOperation({
        binding,
        toolName: "sessions_send",
        toolCallId: "forced-racing-result-send",
        requestDigest: "forced-racing-result-digest",
      }),
    ).toMatchObject({ kind: "execute" });

    const abandonment = forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => root,
    });

    await vi.waitFor(() => {
      expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    });
    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId },
    });
    store.updateAckCursors({ claim, liveEvent: 1 });
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
    expect(
      store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "forced-racing-result-send",
        requestDigest: "forced-racing-result-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);

    await abandonment;

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith(claim);
    unregister();
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

  it("cleans a retained terminal result and journal after restart", async () => {
    let store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "retained-terminal-claim",
      runId: "retained-terminal-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    store.markWorkspaceResultPending(claim);
    const finalRef = workerWorkspaceResultRef(claim.claimId);
    const preparedRef = preparedWorkerWorkspaceResultRef(finalRef);
    const cleanupRef = cleanupWorkerWorkspaceResultRef(finalRef);
    store.recordStagedWorkspaceResult(claim, finalRef);

    const workspacePath = path.join(root, "retained-terminal-workspace");
    await fs.mkdir(workspacePath);
    const initialized = await runCommandWithTimeout(
      ["git", "-C", workspacePath, "init", "--quiet"],
      { timeoutMs: 10_000 },
    );
    expect(initialized.code).toBe(0);
    const artifactPath = path.join(workspacePath, "artifact");
    await fs.writeFile(artifactPath, "retained terminal result\n");
    const hashed = await runCommandWithTimeout(
      ["git", "-C", workspacePath, "hash-object", "-w", artifactPath],
      { timeoutMs: 10_000 },
    );
    expect(hashed.code).toBe(0);
    for (const ref of [finalRef, preparedRef, cleanupRef]) {
      const updated = await runCommandWithTimeout(
        ["git", "-C", workspacePath, "update-ref", ref, hashed.stdout.trim()],
        { timeoutMs: 10_000 },
      );
      expect(updated.code).toBe(0);
    }

    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const appliedManifestRef = `sha256:${"d".repeat(64)}`;
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: appliedManifestRef,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    store.updateWorkspaceBaseManifest({ claim, manifestRef: appliedManifestRef });
    const terminalMessage = "Worker workspace sync failed: lease retained for operator recovery";
    await store.failPendingWorkspaceResult({
      pending: store.listPendingWorkspaceResults()[0]!,
      recoveryError: terminalMessage,
    });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    await upsertSessionEntryCore(
      { agentId: active.agentId, sessionKey: active.sessionKey },
      { sessionId: active.sessionId, updatedAt: 2_000 },
    );
    const restartedHarness = createHarness(store, { workspacePath });
    const environments = {
      ...restartedHarness.environments,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentService;
    const runtime = createGatewayWorkerPlacementRuntime({
      placements: store,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
    });
    expect(store.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: terminalMessage,
      turnClaim: null,
    });
    expect(store.listPendingWorkspaceResults()).toHaveLength(1);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(effects.workerPlacementError).not.toHaveBeenCalledWith(
      expect.stringContaining(`cloud workspace recovery deferred for ${active.sessionId}`),
    );
    await sidecar?.stop();

    await forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => workspacePath,
    });

    expect(store.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      turnClaim: null,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    expect(store.listWorkspaceReconciliationOwners()).toEqual([]);
    for (const ref of [finalRef, preparedRef, cleanupRef]) {
      await expect(
        hasWorkerWorkspaceResultRef({ root: workspacePath, stagedResultRef: ref }),
      ).resolves.toBe(false);
    }
  });

  it("atomically rolls back forced terminal abandonment when the pending identity changed", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "atomic-terminal-claim",
      runId: "atomic-terminal-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    store.markWorkspaceResultPending(claim);
    const terminalMessage = "Worker workspace sync failed: lease retained for operator recovery";
    await store.failPendingWorkspaceResult({
      pending: store.listPendingWorkspaceResults()[0]!,
      recoveryError: terminalMessage,
    });
    const pending = store.listPendingWorkspaceResults()[0]!;

    expect(() =>
      store.forceAbandonPendingWorkspaceResult({
        pending: { ...pending, claimId: "changed-claim" },
        recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      }),
    ).toThrow(`Worker workspace result changed for ${active.sessionId}`);

    expect(store.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: terminalMessage,
      turnClaim: null,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([pending]);

    store.forceAbandonPendingWorkspaceResult({
      pending,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    expect(store.get(active.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      turnClaim: null,
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
    expect(store.canDestroyForceAbandonedEnvironment(environmentId)).toBe(true);
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
    expect(store.canDestroyForceAbandonedEnvironment(environmentId)).toBe(true);
    expect(resolveWorkspacePath).not.toHaveBeenCalled();
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "journal temporarily unreadable" }),
    );
  });
});
