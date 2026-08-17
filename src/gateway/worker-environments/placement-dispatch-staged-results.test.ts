import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const { stageWorkerWorkspaceResult } = workerWorkspaceResultStaging;

describe("staged worker placement result recovery", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-staged-dispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  async function stagePendingResult(params: {
    store: PlacementStore;
    claim: ReturnType<PlacementStore["claimTurn"]>;
    workspacePath: string;
    base?: string;
    current: string;
    record?: boolean;
  }): Promise<{ currentManifestRef: string; stagedResultRef: string }> {
    await fs.mkdir(params.workspacePath, { recursive: true });
    const initialized = await runCommandWithTimeout(
      ["git", "-C", params.workspacePath, "init", "--quiet"],
      { timeoutMs: 10_000 },
    );
    expect(initialized.code).toBe(0);
    const payload = path.join(params.workspacePath, ".staged-payload");
    await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, "result.txt"), params.current);
    if (params.base !== undefined) {
      await fs.writeFile(path.join(params.workspacePath, "result.txt"), params.base);
    }
    const encode = (content: string | undefined) => {
      const raw = JSON.stringify({
        version: 1,
        baseCommit: null,
        entries:
          content === undefined
            ? []
            : [
                {
                  path: "result.txt",
                  type: "file",
                  mode: 0o644,
                  size: Buffer.byteLength(content),
                  sha256: createHash("sha256").update(content).digest("hex"),
                },
              ],
      });
      return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
    };
    const base = encode(params.base);
    const current = encode(params.current);
    params.store.updateWorkspaceBaseManifest({ claim: params.claim, manifestRef: base.ref });
    params.store.markWorkspaceResultPending(params.claim);
    const stagedResultRef = workerWorkspaceResultRef(params.claim.claimId);
    await stageWorkerWorkspaceResult({
      root: params.workspacePath,
      stagingRoot: payload,
      stagedResultRef,
      baseManifestRef: base.ref,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });
    if (params.record !== false) {
      params.store.recordStagedWorkspaceResult(params.claim, stagedResultRef);
    }
    await fs.rm(payload, { recursive: true, force: true });
    return { currentManifestRef: current.ref, stagedResultRef };
  }

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("applies a staged pending result without a tunnel and reclaims the worker", async () => {
    const workspacePath = path.join(root, "same-worker-staged-result");
    const priorConflictRef = "refs/openclaw/worker-results/prior-conflict";
    const harness = createHarness(placementStore, {
      workspacePath,
      priorWorkspaceResultConflict: { paths: ["old.txt"], stagedResultRef: priorConflictRef },
    });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "same-worker-staged-claim",
      runId: "same-worker-staged-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const staged = await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "update-ref", priorConflictRef, staged.stagedResultRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).toBe(0);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "worker\n",
    );
    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: staged.currentManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).not.toBe(0);
    expect(harness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      cleared: true,
    });
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "show-ref", "--verify", priorConflictRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).not.toBe(0);
  });

  it("does not destroy the worker while a nested session operation is running", async () => {
    const workspacePath = path.join(root, "running-session-operation");
    const harness = createHarness(placementStore, { workspacePath });
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "running-session-operation-claim",
      runId: "running-session-operation-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    const binding = claim;
    expect(
      placementStore.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "running-session-operation-call",
        requestDigest: "running-session-operation-digest",
      }),
    ).toMatchObject({ kind: "execute" });
    placementStore.handoffWorkspaceResultRecovery(claim);
    let signalToolAdmissionClosed!: () => void;
    const toolAdmissionClosed = new Promise<void>((resolve) => {
      signalToolAdmissionClosed = resolve;
    });
    const closeWorkerTurnToolState = placementStore.closeWorkerTurnToolState.bind(placementStore);
    // Reconciliation performs real Git I/O before reaching this boundary, so
    // synchronize on admission closure instead of a wall-clock polling budget.
    vi.spyOn(placementStore, "closeWorkerTurnToolState").mockImplementation((closingClaim) => {
      const closing = closeWorkerTurnToolState(closingClaim);
      signalToolAdmissionClosed();
      return closing;
    });

    const reconciliation = harness.service.reconcile();

    await toolAdmissionClosed;
    expect(placementStore.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);

    expect(
      placementStore.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "running-session-operation-call",
        requestDigest: "running-session-operation-digest",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await reconciliation;

    expect(harness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("applies a staged result after restart even when the worker is dead", async () => {
    const workspacePath = path.join(root, "dead-worker-staged-result");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "dead-worker-staged-claim",
      runId: "dead-worker-staged-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const staged = await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore, { workspacePath });
    restartedHarness.markEnvironmentDestroyed();

    await restartedHarness.service.reconcile();

    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "worker\n",
    );
    expect(restartedHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: staged.currentManifestRef,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
    expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
    expect(restartedHarness.log).not.toContain("placement:failed");
  });

  it.each(["active", "draining"] as const)(
    "recovers a staged remote-exec %s result after restart clears its local claim",
    async (placementState) => {
      const workspacePath = path.join(root, `remote-exec-restart-${placementState}-result`);
      const originalHarness = createHarness(placementStore, { workspacePath });
      const active = originalHarness.placements.seedActive(2, "remote-exec");
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claimId = `reclaim-remote-exec-restart-${placementState}`;
      const claimInput = {
        ...REQUEST,
        claimId,
        runId: claimId,
        owner: {
          kind: "local" as const,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      };
      const claim =
        placementState === "active"
          ? placementStore.claimReclaimWorkspaceResult(claimInput)
          : placementStore.claimTurn(claimInput);
      if (placementState === "draining") {
        expect(
          placementStore.startDrain({
            sessionId: active.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: active.generation,
          }),
        ).toMatchObject({ state: "draining" });
      }
      const staged = await stagePendingResult({
        store: placementStore,
        claim,
        workspacePath,
        base: "base\n",
        current: "remote exec\n",
      });

      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      expect(restartedStore.clearLocalTurnClaimsAfterRestart()).toBe(1);
      expect(restartedStore.get(active.sessionId)).toMatchObject({
        state: placementState,
        turnClaim: null,
      });
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(true);
      for (const staleClaim of [
        { ...claim, claimId: `${claim.claimId}-stale` },
        { ...claim, runId: `${claim.runId}-stale` },
        { ...claim, placementGeneration: claim.placementGeneration + 1 },
        {
          ...claim,
          owner: { ...claim.owner, environmentId: `${claim.owner.environmentId}-stale` },
        },
        {
          ...claim,
          owner: { ...claim.owner, ownerEpoch: (claim.owner.ownerEpoch ?? 0) + 1 },
        },
      ]) {
        expect(restartedStore.validateWorkspaceResultClaim(staleClaim)).toBe(false);
        expect(() => restartedStore.acceptWorkspaceResult(staleClaim)).toThrow(
          "Cannot update stale worker workspace result",
        );
      }
      const restartedHarness = createHarness(restartedStore, { workspacePath });
      restartedHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);

      await restartedHarness.service.reconcile();

      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "remote exec\n",
      );
      expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
      expect(restartedHarness.placements.current()).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: staged.currentManifestRef,
      });
      expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
    },
  );

  it("adopts a published result after a crash before its fence-row update", async () => {
    const workspacePath = path.join(root, "published-unrecorded-result");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "published-unrecorded-claim",
      runId: "published-unrecorded-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const staged = await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
      record: false,
    });
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore, { workspacePath });
    restartedHarness.markEnvironmentDestroyed();

    await restartedHarness.service.reconcile();

    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "worker\n",
    );
    expect(restartedHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: staged.currentManifestRef,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("resolves a diverged staged fence and retains its inspectable cloud ref", async () => {
    const workspacePath = path.join(root, "diverged-staged-result");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "diverged-staged-claim",
      runId: "diverged-staged-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const staged = await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "local divergence\n");
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore, { workspacePath });
    restartedHarness.markEnvironmentDestroyed();
    restartedHarness.reportWorkspaceResultConflict.mockRejectedValueOnce(
      new Error("transcript report interrupted"),
    );

    await restartedHarness.service.reconcile();

    expect(restartedStore.listPendingWorkspaceResults()).toMatchObject([
      { stagedResultRef: staged.stagedResultRef, workspaceAcceptedAtMs: 2_000 },
    ]);
    expect(
      await runCommandWithTimeout(
        ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "later local edit\n");
    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(finalStore, { workspacePath });
    finalHarness.markEnvironmentDestroyed();

    await finalHarness.service.reconcile();

    const recovered = finalHarness.placements.current();
    expect(recovered).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceResultConflict: {
        paths: ["result.txt"],
        stagedResultRef: staged.stagedResultRef,
      },
    });
    expect(recovered?.workspaceBaseManifestRef).not.toBe(staged.currentManifestRef);
    expect(finalStore.listPendingWorkspaceResults()).toEqual([]);
    expect(finalHarness.environments.startTunnel).not.toHaveBeenCalled();
    expect(finalHarness.log).not.toContain("placement:failed");
    expect(finalHarness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      paths: ["result.txt"],
      stagedResultRef: staged.stagedResultRef,
      totalCount: 1,
    });
    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "later local edit\n",
    );
    expect(
      await runCommandWithTimeout(
        ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
  });

  it("reports a post-accept revert to the original base as a conflict", async () => {
    const workspacePath = path.join(root, "accepted-clean-local-advance");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "accepted-clean-local-advance-claim",
      runId: "accepted-clean-local-advance-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const staged = await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    const acceptingStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const acceptingHarness = createHarness(acceptingStore, { workspacePath });
    acceptingHarness.markEnvironmentDestroyed();
    vi.spyOn(acceptingStore, "completeWorkspaceResultAndReleaseTurn").mockImplementationOnce(() => {
      throw new Error("release interrupted");
    });

    await acceptingHarness.service.reconcile();

    expect(acceptingStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: 2_000 },
    ]);
    await fs.writeFile(path.join(workspacePath, "result.txt"), "base\n");
    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(finalStore, { workspacePath });
    finalHarness.markEnvironmentDestroyed();

    await finalHarness.service.reconcile();

    expect(finalHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceResultConflict: {
        paths: ["result.txt"],
        stagedResultRef: staged.stagedResultRef,
      },
    });
    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    expect(finalStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("does not replay an unchanged-hash conflicted apply after a crash", async () => {
    const workspacePath = path.join(root, "unchanged-hash-conflict");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "unchanged-hash-conflict-claim",
      runId: "unchanged-hash-conflict-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await stagePendingResult({
      store: placementStore,
      claim,
      workspacePath,
      current: "worker\n",
    });
    const baseManifestRef = placementStore.get(active.sessionId)?.workspaceBaseManifestRef;
    expect(
      (
        await runCommandWithTimeout(["mkfifo", path.join(workspacePath, "result.txt")], {
          timeoutMs: 10_000,
        })
      ).code,
    ).toBe(0);

    const interruptedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const interruptedHarness = createHarness(interruptedStore, { workspacePath });
    interruptedHarness.markEnvironmentDestroyed();
    vi.spyOn(interruptedStore, "acceptWorkspaceResult").mockImplementationOnce(() => {
      throw new Error("acceptance interrupted");
    });
    await interruptedHarness.service.reconcile();

    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    expect(interruptedStore.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef: baseManifestRef,
    });
    await fs.rm(path.join(workspacePath, "result.txt"));

    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(finalStore, { workspacePath });
    finalHarness.markEnvironmentDestroyed();
    await finalHarness.service.reconcile();

    await expect(fs.stat(path.join(workspacePath, "result.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(finalHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      workspaceResultConflict: { paths: ["result.txt"] },
    });
    expect(finalStore.listPendingWorkspaceResults()).toEqual([]);
  });
});
