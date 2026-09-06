import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type PlacementStore,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const { stageWorkerWorkspaceResult } = workerWorkspaceResultStaging;

describe("staged worker placement result recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(() => {
    root = support.testState.root;
    database = support.testState.stateDb;
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  function seedWorkerTurn(harness: ReturnType<typeof createHarness>) {
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "staged-claim",
      runId: "staged-run",
      owner: placementTurnOwner(active),
    });
    return { active, claim };
  }

  async function stagePendingResult(params: {
    store: PlacementStore;
    claim: ReturnType<PlacementStore["claimTurn"]>;
    workspacePath: string;
    base?: string;
    current: string;
    record?: boolean;
  }): Promise<{ baseManifestRef: string; currentManifestRef: string; stagedResultRef: string }> {
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
    return { baseManifestRef: base.ref, currentManifestRef: current.ref, stagedResultRef };
  }

  it("applies a staged pending result without a tunnel and reclaims the worker", async () => {
    const workspacePath = path.join(root, "same-worker-staged-result");
    const priorConflictRef = "refs/openclaw/worker-results/prior-conflict";
    const prepareAcceptedWorkspacePublication = vi.fn(async () => {
      throw new Error("publication snapshot rejected");
    });
    const publishAcceptedWorkspace = vi.fn(async () => undefined);
    const harness = createHarness(placementStore, {
      workspacePath,
      priorWorkspaceResultConflict: { paths: ["old.txt"], stagedResultRef: priorConflictRef },
      prepareAcceptedWorkspacePublication,
      publishAcceptedWorkspace,
    });
    const { active, claim } = seedWorkerTurn(harness);
    harness.markEnvironmentOwnerEpoch(2);
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
    expect(prepareAcceptedWorkspacePublication).toHaveBeenCalledWith(claim);
    expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
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

  it.each(["retained", "removed-before-restart"] as const)(
    "keeps an accepted result fenced until provider deletion succeeds (%s ref)",
    async (refState) => {
      const workspacePath = path.join(root, "accepted-result-cleanup");
      const publishAcceptedWorkspace = vi.fn(async () => undefined);
      const harness = createHarness(placementStore, { workspacePath, publishAcceptedWorkspace });
      const fixtureStart = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
      const tunnels = createWorkerTunnelManager();
      let claim: ReturnType<PlacementStore["claimTurn"]> | undefined;
      vi.spyOn(tunnels, "start").mockImplementation(async (request) => ({
        ...(await fixtureStart(request)),
        reconcileWorkspace: async ({ journal }) => {
          const owned = placementStore.get(REQUEST.sessionId);
          if (owned?.state !== "draining" || !owned.turnClaim) {
            throw new Error("reclaim fixture lost its claim");
          }
          claim = {
            sessionId: owned.sessionId,
            claimId: owned.turnClaim.claimId,
            runId: owned.turnClaim.runId,
            placementGeneration: owned.turnClaim.generation,
            owner: placementTurnOwner(owned),
          };
          const staged = await stagePendingResult({
            store: placementStore,
            claim,
            workspacePath,
            base: "base\n",
            current: "worker\n",
          });
          const applied = await applyStagedWorkerWorkspaceResult({
            root: workspacePath,
            stagedResultRef: staged.stagedResultRef,
            expectedBaseManifestRef: staged.baseManifestRef,
            journal,
          });
          return {
            ...applied,
            verifyStable: async () => {},
            getAppliedWorkspaceResult: () => applied,
          };
        },
      }));
      const destroy = vi.fn(async (): Promise<void> => {
        throw new Error("provider deletion unavailable");
      });
      support.testState.prepareInstallation = async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      });
      const environments = support.createService(support.createProvider({ destroy }), {
        tunnelManager: tunnels,
        placementStore: createWorkerSessionPlacementGate(placementStore),
      });
      const ready = await environments.create(
        "development",
        "session-dispatch:session-1:1",
        undefined,
        "remote-exec",
      );
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      seedActivePlacement(placementStore, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      harness.markEnvironmentOwnerEpoch(attached.ownerEpoch);
      Object.assign(harness.environments, environments);

      await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(
        "provider deletion unavailable",
      );
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "destroying",
        ownerEpoch: attached.ownerEpoch + 1,
        destroyRequestedAtMs: 1_000,
        leaseId: ready.leaseId,
      });
      const [pending] = placementStore.listPendingWorkspaceResults();
      expect(pending).toMatchObject({ workspaceAcceptedAtMs: 1_000 });
      if (!pending?.stagedResultRef) {
        throw new Error("reclaim fixture did not retain its staged result");
      }
      let recovery = harness;
      if (refState === "removed-before-restart") {
        expect(
          await runCommandWithTimeout(
            [
              "git",
              "-C",
              workspacePath,
              "update-ref",
              "-d",
              cleanupWorkerWorkspaceResultRef(pending.stagedResultRef),
            ],
            { timeoutMs: 10_000 },
          ),
        ).toMatchObject({ code: 0 });
        const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
        restartedStore.clearLocalTurnClaimsAfterRestart();
        recovery = createHarness(restartedStore, { workspacePath, publishAcceptedWorkspace });
        Object.assign(recovery.environments, environments);
      }

      await recovery.service.reconcileActive(ready.environmentId);

      await expect(recovery.service.reclaim(REQUEST)).rejects.toThrow(
        refState === "retained"
          ? "cannot stop cloud worker"
          : "Active cloud worker does not match its session placement",
      );
      expect(placementStore.listPendingWorkspaceResults()).toMatchObject([pending]);
      destroy.mockResolvedValue(undefined);
      await recovery.service.reconcileActive(ready.environmentId);
      await expect(recovery.service.reclaim(REQUEST)).resolves.toMatchObject({
        state: "reclaimed",
      });
      expect(environments.get(ready.environmentId)?.state).toBe("destroyed");
      expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
      expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "worker\n",
      );
    },
  );

  it("does not destroy the worker while a nested session operation is running", async () => {
    const workspacePath = path.join(root, "running-session-operation");
    const harness = createHarness(placementStore, { workspacePath });
    const { active, claim } = seedWorkerTurn(harness);
    harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
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
      state: "draining",
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
    const { claim } = seedWorkerTurn(originalHarness);
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

  it.each(["active", "draining", "draining-reclaim", "accepted-reclaim"] as const)(
    "recovers a staged remote-exec %s result after restart clears its local claim",
    async (placementState) => {
      const workspacePath = path.join(root, `remote-exec-restart-${placementState}-result`);
      const originalHarness = createHarness(placementStore, {
        workspacePath,
        destroyFailureCount: placementState === "accepted-reclaim" ? 1 : 0,
      });
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
      const drain = () => {
        expect(
          placementStore.startDrain({
            sessionId: active.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: active.generation,
          }),
        ).toMatchObject({ state: "draining" });
      };
      if (placementState === "draining-reclaim" || placementState === "accepted-reclaim") {
        drain();
      }
      const claim =
        placementState === "draining"
          ? placementStore.claimTurn(claimInput)
          : placementStore.claimReclaimWorkspaceResult(claimInput);
      if (placementState === "draining") {
        drain();
      }
      const staged = await stagePendingResult({
        store: placementStore,
        claim,
        workspacePath,
        base: "base\n",
        current: "remote exec\n",
      });
      if (placementState === "accepted-reclaim") {
        originalHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
        placementStore.handoffWorkspaceResultRecovery(claim);
        await originalHarness.service.reconcile();
        expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
          { workspaceAcceptedAtMs: 1_000, placementGeneration: claim.placementGeneration },
        ]);
        expect(originalHarness.environments.destroy).toHaveBeenCalledOnce();
      }

      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      expect(restartedStore.clearLocalTurnClaimsAfterRestart()).toBe(1);
      expect(restartedStore.get(active.sessionId)).toMatchObject({
        state: placementState === "active" ? "active" : "draining",
        turnClaim: null,
      });
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(true);
      for (const staleClaim of [
        { ...claim, claimId: `${claim.claimId}-stale` },
        { ...claim, runId: `${claim.runId}-stale` },
        { ...claim, placementGeneration: claim.placementGeneration - 1 },
        { ...claim, placementGeneration: claim.placementGeneration + 1 },
        { ...claim, placementGeneration: claim.placementGeneration + 2 },
        {
          ...claim,
          owner: {
            kind: "worker" as const,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
        },
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
      expect(() =>
        restartedStore.claimReclaimWorkspaceResult({
          ...claimInput,
          claimId: "reclaim-replacement",
          runId: "reclaim-replacement",
        }),
      ).toThrow("Worker workspace result is already pending");
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(true);
      const restartedHarness = createHarness(restartedStore, { workspacePath });
      restartedHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      if (placementState === "accepted-reclaim") {
        restartedHarness.markEnvironmentDestroyed();
        expect(restartedHarness.environments.get(active.environmentId)).toMatchObject({
          state: "destroyed",
          ownerEpoch: active.activeOwnerEpoch + 1,
        });
      }

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
      if (placementState === "accepted-reclaim") {
        expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
        expect(
          await runCommandWithTimeout(
            [
              "git",
              "-C",
              workspacePath,
              "show-ref",
              "--verify",
              cleanupWorkerWorkspaceResultRef(staged.stagedResultRef),
            ],
            { timeoutMs: 10_000 },
          ),
        ).not.toMatchObject({ code: 0 });
      }
    },
  );

  it("adopts a published result after a crash before its fence-row update", async () => {
    const workspacePath = path.join(root, "published-unrecorded-result");
    const originalHarness = createHarness(placementStore, { workspacePath });
    const { claim } = seedWorkerTurn(originalHarness);
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
    const { active, claim } = seedWorkerTurn(originalHarness);
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
    restartedHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    const secret = [
      String.fromCharCode(115, 107),
      "proj",
      "recovery",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    const failure = new Error(
      `transcript report interrupted token=${secret} ${"detail ".repeat(200)}`,
    );
    restartedHarness.reportWorkspaceResultConflict
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    restartedHarness.reportWorkspaceResultRecoveryFailure.mockRejectedValueOnce(
      new Error("recovery transcript temporarily unavailable"),
    );

    await restartedHarness.service.reconcile();

    expect(restartedStore.listPendingWorkspaceResults()).toMatchObject([
      { stagedResultRef: staged.stagedResultRef, workspaceAcceptedAtMs: 2_000 },
    ]);
    expect(restartedStore.get(active.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId, runId: claim.runId },
    });
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
    expect(restartedHarness.reportWorkspaceResultRecoveryFailure).toHaveBeenCalledOnce();
    const recovery = restartedHarness.reportWorkspaceResultRecoveryFailure.mock.calls[0]?.[0];
    expect(recovery).toMatchObject({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      error: expect.stringContaining("transcript report interrupted"),
    });
    expect(JSON.stringify(recovery)).not.toContain(secret);
    expect(recovery?.error.length).toBeLessThanOrEqual(1_024);

    await restartedHarness.service.reconcile();

    expect(restartedHarness.reportWorkspaceResultRecoveryFailure).toHaveBeenCalledTimes(2);
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
    expect(
      await runCommandWithTimeout(
        ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "later local edit\n");
    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(finalStore, { workspacePath });
    finalHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);

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
    expect(finalHarness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(finalHarness.reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
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
    const { claim } = seedWorkerTurn(originalHarness);
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
    const { active, claim } = seedWorkerTurn(originalHarness);
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
