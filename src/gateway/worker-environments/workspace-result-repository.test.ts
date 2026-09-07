import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import {
  createPlacementFailureActions,
  type WorkerDispatchEnvironmentService,
} from "./placement-dispatch-failure.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import { placementTurnOwner, projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import { readSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  credential,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  placements,
  root,
  seedActivePlacement,
  SESSION_ID,
  sessionTarget,
  setupWorkerTurnLauncherTest,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// This fixture clones a local Git origin; no GitHub identity is involved.
vi.mock("./worker-github-binding.js", () => ({
  prepareWorkerGitHubBinding: async () => undefined,
}));

describe("repository workspace result ownership", () => {
  let closeNode: (() => Promise<void>) | undefined;
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    try {
      await closeNode?.();
    } finally {
      closeNode = undefined;
      await cleanupWorkerTurnLauncherTest();
    }
  });

  async function fixture(executionMode: "worker-turn" | "remote-exec", runSetupScript = false) {
    setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
    const origin = path.join(root, "origin");
    await fs.mkdir(origin);
    if (runSetupScript) {
      await fs.mkdir(path.join(origin, ".openclaw"));
      await fs.writeFile(
        path.join(origin, ".openclaw", "worktree-setup.sh"),
        "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
        { mode: 0o755 },
      );
    }
    const git = async (...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", origin, ...args], {
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
    };
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Repository Test",
      "-c",
      "user.email=repository@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "base",
    );
    const store = getSessionRepositoryWorkspaceStore();
    const repository = store.create({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      url: pathToFileURL(origin).href,
      runSetupScript,
      assertCurrent: () => {},
    });
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
      repositoryWorkspaceId: repository.workspaceId,
    });
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({ credential: credential(), environment: attachedEnvironment() }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    closeNode = async () => {
      await server.close();
      await service.closeAll();
    };
    const home = path.join(root, "node-home");
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "node-host"),
      env: { PATH: process.env.PATH, HOME: home },
    });
    const ownerSignal = new AbortController().signal;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      stop: vi.fn(),
      ...createNodeWorkerWorkspaceActions({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        ownerSignal,
        isOwnerCurrent: () => true,
        workspaceTransfer: service,
        runWorkspaceCommand: async (command) =>
          await runtime.exec(
            {
              gatewayNamespace: "gateway-repository-results",
              environmentId: ENVIRONMENT_ID,
              sessionId: SESSION_ID,
              generation: OWNER_EPOCH,
              ...command,
              argv: [...command.argv],
            },
            ownerSignal,
            { url: server.gatewayUrl },
          ),
      }),
    };
    const synced = await syncSessionRepositoryWorkspace({
      ...sessionTarget,
      repository,
      tunnel,
      generation: 1,
      runSetupScript,
      assertCurrent: () => {},
    });
    const remote = synced.remoteWorkspaceDir;
    const initialCheckpointRef = store.get(repository.workspaceId)!.checkpointRef;
    seedActivePlacement(executionMode, remote, synced.manifestRef);
    const beginTurn = (claimId: string, markResultPending = true) => {
      const placement = placements.get(SESSION_ID);
      if (placement?.state !== "active") {
        throw new Error("expected an active repository placement");
      }
      const turnClaim = placements.claimTurn({
        ...sessionTarget,
        claimId,
        runId: claimId,
        owner: placementTurnOwner(placement),
      });
      if (markResultPending) {
        placements.markWorkspaceResultPending(turnClaim);
      }
      return { placement, turnClaim };
    };
    const finishTurn = (
      owned: ReturnType<typeof beginTurn>,
      publishAcceptedWorkspace?: () => Promise<void>,
    ) =>
      reconcileWorkspaceAfterTurn({
        ...owned,
        placements,
        workspaceOperations,
        workspace: { kind: "repository", repository: store.get(repository.workspaceId)! },
        transcriptTarget: sessionTarget,
        tunnel,
        publishAcceptedWorkspace,
      });
    const environments: WorkerDispatchEnvironmentService = {
      get: () => attachedEnvironment(),
      create: vi.fn(async () => attachedEnvironment()),
      createFromProfileSnapshot: vi.fn(async () => attachedEnvironment()),
      attachSession: vi.fn(async () => credential()),
      destroy: vi.fn(async () => attachedEnvironment()),
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      reconcileEnvironment: vi.fn(async () => {}),
      reconcileOnce: vi.fn(async () => {}),
      supportsProviderExecutionMode: () => true,
    };
    const resolveWorkspace = async () => ({
      kind: "repository" as const,
      repository: store.get(repository.workspaceId)!,
    });
    const mutations = createRepositoryWorkspaceMutationService({
      placements,
      environments,
      resolveWorkspace,
      workspaceOperations,
    });
    const stop = createWorkerPlacementReclaim({
      placements,
      environments,
      workspaceOperations,
      runReclaimBarrier: async ({ begin, reclaim }) =>
        await reclaim(await resolveWorkspace(), begin()),
      resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
      reportWorkspaceResultConflict: async () => {},
    });
    return {
      remote,
      store,
      repository,
      initialCheckpointRef,
      beginTurn,
      finishTurn,
      workspaceOperations,
      mutations,
      stop,
      environments,
      resolveWorkspace,
      tunnel,
    };
  }

  it.each(["worker-turn", "remote-exec"] as const)(
    "makes a successful %s editor save durable before returning and leaves unchanged saves untouched",
    async (executionMode) => {
      const f = await fixture(executionMode);
      const saved = await f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async (assertCurrent) => {
          expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
          assertCurrent();
          await fs.writeFile(path.join(f.remote, "editor.txt"), "saved from editor\n");
          return { changed: true, value: "saved" };
        },
      });
      expect(saved).toBe("saved");
      const checkpoint = await readSessionRepositoryCheckpoint({
        workspaceId: f.repository.workspaceId,
      });
      expect((await checkpoint.readEntry(checkpoint.changedEntries[0]!)).toString()).toBe(
        "saved from editor\n",
      );
      expect(placements.get(SESSION_ID)?.workspaceBaseManifestRef).toBe(
        checkpoint.currentManifestRef,
      );
      const accepted = f.store.get(f.repository.workspaceId);
      await expect(
        f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async () => ({ changed: false, value: "unchanged" }),
        }),
      ).resolves.toBe("unchanged");
      expect(f.store.get(f.repository.workspaceId)).toEqual(accepted);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "recovers unknown %s editor writes through pending result custody",
    async (executionMode) => {
      const f = await fixture(executionMode);
      await expect(
        f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async () => {
            await fs.writeFile(
              path.join(f.remote, "uncertain.txt"),
              "write completed before transport loss\n",
            );
            throw new Error("editor transport lost the acknowledgement");
          },
        }),
      ).rejects.toThrow("lost the acknowledgement");
      expect(placements.listPendingWorkspaceResults()).toMatchObject([
        {
          workspaceAcceptedAtMs: null,
          recoveryRequestedAtMs: expect.any(Number),
        },
      ]);
      await recoverPendingWorkspaceResults(
        {
          placements,
          environments: f.environments,
          failure: createPlacementFailureActions({ placements, environments: f.environments }),
          workspaceOperations: f.workspaceOperations,
          resolveWorkspace: f.resolveWorkspace,
          resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
          reportWorkspaceResultConflict: async () => {},
        },
        false,
      );
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      const checkpoint = await readSessionRepositoryCheckpoint({
        workspaceId: f.repository.workspaceId,
      });
      expect((await checkpoint.readEntry(checkpoint.changedEntries[0]!)).toString()).toBe(
        "write completed before transport loss\n",
      );
    },
  );

  it.each(["publisher", "editor"] as const)(
    "excludes competing publication and editor writes when the %s acquires first",
    async (firstOwner) => {
      const f = await fixture("worker-turn");
      const competing = vi.fn(async () => ({ changed: false, value: "unexpected" }));
      if (firstOwner === "publisher") {
        await placements.withRepositoryWorkspaceReservation(sessionTarget, async (assertOwned) => {
          await expect(
            f.mutations.mutate({
              ...sessionTarget,
              assertCurrent: () => {},
              mutate: competing,
            }),
          ).rejects.toThrow("being published");
          assertOwned();
        });
      } else {
        await f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async (assertCurrent) => {
            await expect(
              placements.withRepositoryWorkspaceReservation(sessionTarget, competing),
            ).rejects.toThrow("checkpoint is busy");
            assertCurrent();
            return { changed: false, value: "unchanged" };
          },
        });
      }
      expect(competing).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("preserves editor result custody when capture returns without durable acceptance", async () => {
    const f = await fixture("worker-turn");
    vi.spyOn(f.tunnel, "reconcileWorkspace").mockResolvedValue({
      manifestRef: placements.get(SESSION_ID)!.workspaceBaseManifestRef!,
      changed: true,
      verifyStable: async () => {},
      verifyLocalStable: async () => {},
    });
    await expect(
      f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "unaccepted.txt"), "save requires a checkpoint\n");
          return { changed: true, value: "saved" };
        },
      }),
    ).rejects.toThrow("not durably accepted");
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(f.initialCheckpointRef);
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, recoveryRequestedAtMs: expect.any(Number) },
    ]);
  });

  it("rejects editor writes during an admitted turn and fences writes if their placement starts draining", async () => {
    const f = await fixture("worker-turn");
    const activeTurn = f.beginTurn("running-turn");
    const mutate = vi.fn(async () => ({ changed: true, value: "unexpected" }));
    await expect(
      f.mutations.mutate({ ...sessionTarget, assertCurrent: () => {}, mutate }),
    ).rejects.toThrow("active turn claim");
    expect(mutate).not.toHaveBeenCalled();
    placements.acceptWorkspaceResult(activeTurn.turnClaim);
    placements.completeWorkspaceResultAndReleaseTurn(activeTurn.turnClaim);

    await expect(
      f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "interrupted.txt"), "must remain recoverable\n");
          expect(() =>
            placements.startDrain({
              sessionId: SESSION_ID,
              environmentId: activeTurn.placement.environmentId,
              ownerEpoch: activeTurn.placement.activeOwnerEpoch,
              expectedGeneration: activeTurn.placement.generation,
            }),
          ).toThrow("pending cloud workspace result");
          const claim = projectWorkerSessionTurnClaim(placements.get(SESSION_ID)!);
          expect(claim).toBeDefined();
          placements.startWorkspaceResultDrain(claim!);
          return { changed: true, value: "unaccepted" };
        },
      }),
    ).rejects.toThrow("lost its exact session placement owner");
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(f.initialCheckpointRef);
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      {
        recoveryRequestedAtMs: expect.any(Number),
        workspaceAcceptedAtMs: null,
      },
    ]);
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "retains setup and cumulative %s changes through turns, editor saves, and Stop",
    async (executionMode) => {
      const f = await fixture(executionMode, true);
      const pinned = f.store.get(f.repository.workspaceId)!;
      expect(pinned.manifestHash).not.toBe(pinned.baseManifestHash);
      await fs.writeFile(path.join(f.remote, "first.txt"), "first turn\n");
      const first = f.beginTurn("first");
      await f.finishTurn(first);
      await fs.writeFile(path.join(f.remote, "second.txt"), "second turn\n");
      await f.finishTurn(f.beginTurn("second"));
      await f.finishTurn(f.beginTurn("read-only"));
      await f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "editor.txt"), "editor save\n");
          return { changed: true, value: undefined };
        },
      });
      await f.stop(sessionTarget);
      expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
      const snapshot = await readSessionRepositoryCheckpoint({
        workspaceId: f.repository.workspaceId,
      });
      expect(snapshot.changedEntries.map((entry) => entry.path)).toEqual([
        "editor.txt",
        "first.txt",
        "second.txt",
        "setup.txt",
      ]);
      const expected = new Map([
        ["editor.txt", "editor save\n"],
        ["first.txt", "first turn\n"],
        ["second.txt", "second turn\n"],
        ["setup.txt", "prepared\n"],
      ]);
      for (const entry of snapshot.changedEntries) {
        expect((await snapshot.readEntry(entry)).toString()).toBe(expected.get(entry.path));
      }
      expect(snapshot.baseManifestRef).toBe(pinned.baseManifestHash);
      expect(f.store.get(f.repository.workspaceId)?.baseManifestHash).toBe(pinned.baseManifestHash);
      const artifactRoot = f.store.artifactPath(f.repository.workspaceId);
      expect(
        await requireWorkspaceResultGit(artifactRoot, ["rev-parse", "--is-bare-repository"]),
      ).toBe("true");
      await expect(fs.stat(path.join(artifactRoot, "first.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await hasWorkerWorkspaceResultRef({
          root: artifactRoot,
          stagedResultRef: workerWorkspaceResultRef(first.turnClaim.claimId),
        }),
      ).toBe(true);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("binds a staged repository result to its exact immutable session owner", async () => {
    const f = await fixture("worker-turn");
    const { turnClaim } = f.beginTurn("source-binding");
    const foreign = f.store.create({
      agentId: sessionTarget.agentId,
      sessionKey: "agent:main:other-repository",
      url: f.repository.url,
      assertCurrent: () => {},
    });
    const ref = workerWorkspaceResultRef(turnClaim.claimId);
    expect(() =>
      placements.recordStagedWorkspaceResult(turnClaim, ref, foreign.workspaceId),
    ).toThrow("repository owner changed");
    expect(placements.listPendingWorkspaceResults()).toMatchObject([{ stagedResultRef: null }]);
    placements.recordStagedWorkspaceResult(turnClaim, ref, f.repository.workspaceId);
    expect(() => placements.recordStagedWorkspaceResult(turnClaim, ref)).toThrow(
      "result ref changed",
    );
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      {
        stagedResultRef: ref,
        repositoryWorkspaceId: f.repository.workspaceId,
      },
    ]);
  });

  it.each([
    { executionMode: "worker-turn", phase: "pending-pointer", materialized: false },
    { executionMode: "remote-exec", phase: "pending-pointer", materialized: false },
    { executionMode: "worker-turn", phase: "Gateway materialization", materialized: true },
    { executionMode: "remote-exec", phase: "Gateway materialization", materialized: true },
  ] as const)(
    "recovers an accepted $executionMode checkpoint after restart during $phase",
    async ({ executionMode, materialized }) => {
      const f = await fixture(executionMode);
      await fs.writeFile(path.join(f.remote, "survives.txt"), "durable before restart\n");
      const owned = f.beginTurn("interrupted", !materialized);
      const destination = path.join(root, "materialized-worktree");
      if (materialized) {
        const database = openOpenClawStateDatabase();
        executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<Pick<DB, "worker_environments">>(database.db)
            .insertInto("worker_environments")
            .values({
              environment_id: owned.placement.environmentId,
              provider_id: "fixture",
              profile_id: "development",
              profile_snapshot_json: "{}",
              provision_operation_id: "repository-result-move",
              lease_id: "repository-result-lease",
              state: "attached",
              owner_epoch: owned.placement.activeOwnerEpoch,
              attached_session_ids_json: JSON.stringify([SESSION_ID]),
              created_at_ms: 1,
              updated_at_ms: 1,
              state_changed_at_ms: 1,
            }),
        );
        placements.beginPlacementMove({
          sessionId: SESSION_ID,
          source: {
            generation: owned.placement.generation,
            environmentId: owned.placement.environmentId,
            ownerEpoch: owned.placement.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
        });
        placements.markWorkspaceResultPending(owned.turnClaim);
        await expect(
          f.finishTurn(owned, async () => {
            await fs.mkdir(destination);
            await fs.copyFile(
              path.join(f.remote, "survives.txt"),
              path.join(destination, "survives.txt"),
            );
            await patchSessionEntryCore(
              sessionTarget,
              (entry) => ({ ...entry, repositoryWorkspaceId: undefined }),
              { replaceEntry: true },
            );
            expect(loadSessionEntry(sessionTarget)?.repositoryWorkspaceId).toBeUndefined();
            throw new Error("process exited after Gateway materialization");
          }),
        ).rejects.toThrow("process exited after Gateway materialization");
      } else {
        const record = vi
          .spyOn(placements, "recordStagedWorkspaceResult")
          .mockImplementationOnce(() => {
            throw new Error("process exited before pending pointer");
          });
        await expect(f.finishTurn(owned)).rejects.toThrow("process exited before pending pointer");
        record.mockRestore();
      }
      const checkpointRef = workerWorkspaceResultRef(owned.turnClaim.claimId);
      expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(checkpointRef);
      expect(placements.listPendingWorkspaceResults()).toMatchObject([
        materialized
          ? {
              stagedResultRef: checkpointRef,
              repositoryWorkspaceId: f.repository.workspaceId,
              workspaceAcceptedAtMs: expect.any(Number),
            }
          : { stagedResultRef: null, workspaceAcceptedAtMs: null },
      ]);
      await fs.rm(f.remote, { recursive: true });
      if (materialized) {
        const database = openOpenClawStateDatabase();
        executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<Pick<DB, "worker_environments">>(database.db)
            .deleteFrom("worker_environments")
            .where("environment_id", "=", owned.placement.environmentId),
        );
      }
      closeOpenClawStateDatabaseForTest();
      const restarted = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      const environments: WorkerDispatchEnvironmentService = {
        get: () => undefined,
        create: vi.fn(async () => attachedEnvironment()),
        createFromProfileSnapshot: vi.fn(async () => attachedEnvironment()),
        attachSession: vi.fn(async () => credential()),
        destroy: vi.fn(async () => attachedEnvironment()),
        startTunnel: vi.fn(async () => {
          throw new Error("worker is gone");
        }),
        stopTunnel: vi.fn(async () => {}),
        reconcileEnvironment: vi.fn(async () => {}),
        reconcileOnce: vi.fn(async () => {}),
        supportsProviderExecutionMode: () => true,
      };
      const reportWorkspaceResultRecoveryFailure = vi.fn(async () => {});
      await recoverPendingWorkspaceResults(
        {
          placements: restarted,
          environments,
          failure: createPlacementFailureActions({ placements: restarted, environments }),
          workspaceOperations: f.workspaceOperations,
          resolveWorkspace: async () =>
            materialized
              ? { kind: "local", path: destination }
              : { kind: "repository", repository: f.store.get(f.repository.workspaceId)! },
          resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
          reportWorkspaceResultConflict: async () => {},
          reportWorkspaceResultRecoveryFailure,
        },
        true,
      );
      expect(reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
      expect(restarted.listPendingWorkspaceResults()).toEqual([]);
      expect(restarted.get(SESSION_ID)).toMatchObject({
        state: materialized ? "local" : "reclaimed",
        turnClaim: null,
      });
      expect(environments.startTunnel).not.toHaveBeenCalled();
      const saved = await readSessionRepositoryCheckpoint({
        workspaceId: f.repository.workspaceId,
      });
      expect((await saved.readEntry(saved.changedEntries[0]!)).toString()).toBe(
        "durable before restart\n",
      );
    },
  );
});
