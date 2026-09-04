import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import type { NodeWorkerWorkspaceRetainEntry } from "../../worker/node-workspace-retain-protocol.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { executeRemoteExecTurn, reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

vi.mock("../../node-host/node-worker-transfer-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-host/node-worker-transfer-client.js")>()),
  runNodeWorkerWorkspaceTransfer: vi.fn(),
}));

describe("concurrent worker workspace results", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("reports cleanup failure and reclaims the inputs before the next turn without skills", async () => {
    const remote = path.join(await fs.realpath(root), "remote");
    const source = path.join(root, "source");
    await fs.mkdir(remote);
    await fs.mkdir(path.join(source, "skills", "synthetic"), { recursive: true });
    await fs.writeFile(
      path.join(source, "skills", "synthetic", "SKILL.md"),
      "---\ndescription: Synthetic resource\n---\n# Resource\n",
    );
    seedActivePlacement("remote-exec", remote);
    const placement = placements.get(SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("expected active placement");
    }
    const inputTurn = {
      ...turn("cleanup-failure"),
      skillsSnapshot: buildSkillSnapshot(source, {
        entries: loadWorkspaceSkills(source, { workspaceOnly: true }),
      }),
    };
    const turnClaim = placements.claimTurn({
      ...sessionTarget,
      owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      claimId: "cleanup-failure",
      runId: inputTurn.runId,
    });
    let failCleanup = true;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runWorkspaceCommand: async (command) => {
        if (JSON.parse(command.input!).op === "cleanup" && failCleanup) {
          failCleanup = false;
          return {
            code: 1,
            stdout: "",
            stderr: "cleanup denied",
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return await runCommandWithTimeout([...command.argv], {
          cwd: remote,
          input: command.input,
          timeoutMs: 5_000,
        });
      },
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: async (request) => {
        request.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
        };
      },
      syncWorkspace: vi.fn(),
      stop: async () => {},
    };
    await expect(
      executeRemoteExecTurn({
        environments: { get: attachedEnvironment, startTunnel: async () => tunnel },
        onHandoff: () => {},
        placement,
        placements,
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        turn: inputTurn,
        turnClaim,
        localWorkspaceDir: root,
        runLocal: async () => ({ meta: { durationMs: 1 } }),
      }),
    ).rejects.toThrow("Skill resource cleanup failed");
    expect(placements.listPendingWorkspaceResults()).toEqual([]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

    const leftovers = await fs.readdir(remote);
    expect(leftovers).toHaveLength(1);
    const nextTurn = turn("cleanup-recovery");
    const nextClaim = placements.claimTurn({
      ...sessionTarget,
      owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      claimId: "cleanup-recovery",
      runId: nextTurn.runId,
    });
    let executed = false;
    await executeRemoteExecTurn({
      environments: { get: attachedEnvironment, startTunnel: async () => tunnel },
      onHandoff: () => {},
      placement,
      placements,
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      turn: nextTurn,
      turnClaim: nextClaim,
      localWorkspaceDir: root,
      runLocal: async () => {
        expect(await fs.readdir(remote)).toEqual([]);
        executed = true;
        return { meta: { durationMs: 1 } };
      },
    });
    expect(executed).toBe(true);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it.each([1, 50])(
    "reconciles %i completed turns when an older retention snapshot arrives after upload",
    async (count) => {
      const repository = path.join(root, "repository");
      const payload = path.join(root, "payload");
      await fs.mkdir(repository);
      await fs.mkdir(payload);
      const git = async (cwd: string, ...args: string[]) => {
        const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
          timeoutMs: 10_000,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr || result.stdout);
        }
        return result.stdout.trim();
      };
      await git(repository, "init", "--quiet");
      await git(
        repository,
        "-c",
        "user.name=Workspace Test",
        "-c",
        "user.email=workspace@example.invalid",
        "-c",
        `core.hooksPath=${os.devNull}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "base",
      );
      const baseCommit = await git(repository, "rev-parse", "HEAD");
      const base = await readActualWorkspaceManifest({ root: repository, baseCommit });
      const bytes = Buffer.from("worker result\n\0binary\xff", "latin1");
      await fs.writeFile(path.join(payload, "result.bin"), bytes);
      const current = await readActualWorkspaceManifest({ root: payload, baseCommit });
      const node = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
      // Model HTTP delivery only; command serialization, manifest verification, retention,
      // claims, journals, and managed-worktree application all use their real owners.
      vi.mocked(runNodeWorkerWorkspaceTransfer).mockImplementation(async (input) => {
        await fs.mkdir(input.workspaceDir, { recursive: true });
        await git(input.workspaceDir, "init", "--quiet");
        await fs.copyFile(
          path.join(payload, "result.bin"),
          path.join(input.workspaceDir, "result.bin"),
        );
        const manifests = path.join(input.manifestHome, ".openclaw-worker", "manifests");
        await fs.mkdir(manifests, { recursive: true });
        for (const snapshot of [base, current]) {
          await fs.writeFile(
            path.join(manifests, `${snapshot.manifestRef.slice(7)}.json`),
            serializeWorkerWorkspaceManifest(snapshot.manifest),
          );
        }
        return current.manifestRef;
      });
      const retain: NodeWorkerWorkspaceRetainEntry[] = [];
      const retained = createDeferred();
      let uploadsRemaining = count;
      const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
      const jobs = [];
      for (let index = 0; index < count; index++) {
        const sessionId = `session-${index}`;
        const environmentId = `environment-${index}`;
        const localWorkspaceDir = path.join(root, `worktree-${index}`);
        await git(repository, "worktree", "add", "--quiet", "--detach", localWorkspaceDir);
        const identity = { sessionId, sessionKey: `agent:main:${sessionId}`, agentId: "main" };
        const transcriptTarget = { ...sessionTarget, ...identity };
        await upsertSessionEntryCore(transcriptTarget, { sessionId, updatedAt: Date.now() });
        let placement = placements.startDispatch(identity);
        for (const transition of [
          { from: "requested", to: "provisioning", patch: { environmentId } },
          { from: "provisioning", to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
          {
            from: "syncing",
            to: "starting",
            patch: {
              remoteWorkspaceDir: `/worker/${sessionId}`,
              workspaceBaseManifestRef: base.manifestRef,
            },
          },
          { from: "starting", to: "active", patch: { activeOwnerEpoch: 1 } },
        ] as const) {
          placement = placements.transition({
            ...transition,
            sessionId,
            expectedGeneration: placement.generation,
          });
        }
        if (placement.state !== "active") {
          throw new Error("expected active placement");
        }
        const turnClaim = placements.claimTurn({
          ...identity,
          owner: { kind: "worker", environmentId, ownerEpoch: 1 },
          claimId: `claim-${index}`,
          runId: `run-${index}`,
        });
        placements.markWorkspaceResultPending(turnClaim);
        const nodeIdentity = {
          gatewayNamespace: "gateway-test",
          environmentId,
          sessionId,
          generation: 1,
        };
        retain.push({ environmentId, sessionId, generation: 1, manifestRefs: [base.manifestRef] });
        const tunnel: WorkerTunnelHandle = {
          environmentId,
          ownerEpoch: 1,
          runWorkspaceCommand: async () => {
            throw new Error("unexpected workspace command");
          },
          syncWorkspace: async () => {
            throw new Error("workspace already synced");
          },
          stop: async () => {},
          quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
          reconcileWorkspace: async (request) => {
            const uploaded = await node.exec(
              {
                ...nodeIdentity,
                argv: ["openclaw-internal-workspace-transfer"],
                transfer: {
                  direction: "upload",
                  token: "fixture-upload",
                  baseManifestRef: base.manifestRef,
                },
              },
              undefined,
              { url: "ws://gateway.invalid" },
            );
            if (--uploadsRemaining === 0) {
              try {
                await node.applyRetainSnapshot(
                  {
                    version: 1,
                    gatewayNamespace: "gateway-test",
                    controllerId: "controller",
                    sequence: 1,
                    retain,
                  },
                  () => [],
                );
                retained.resolve();
              } catch (error) {
                retained.reject(error);
              }
            }
            await retained.promise;
            const verifyStable = async () => {
              const captured = await node.exec({
                ...nodeIdentity,
                argv: [
                  "node",
                  "-e",
                  REMOTE_WORKSPACE_MANIFEST_JS,
                  uploaded.workspaceDir,
                  baseCommit,
                  "eligible",
                  current.manifestRef.slice(7),
                ],
              });
              if (captured.code !== 0) {
                throw new Error(captured.stderr);
              }
              expect(captured.stdout.trim()).toBe(current.manifestRef);
            };
            await verifyStable();
            return {
              ...(await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
                request,
                stagingRoot: payload,
                currentManifestRef: current.manifestRef,
                baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
                currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
              })),
              manifestRef: current.manifestRef,
              changed: true,
              verifyStable,
            };
          },
        };
        jobs.push({ placement, turnClaim, tunnel, localWorkspaceDir, transcriptTarget });
      }
      const outcomes = await Promise.allSettled(
        jobs.map((job) =>
          reconcileWorkspaceAfterTurn({
            ...job,
            placements,
            workspaceOperations,
          }),
        ),
      );
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toBeUndefined();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      for (const job of jobs) {
        expect(await fs.readFile(path.join(job.localWorkspaceDir, "result.bin"))).toEqual(bytes);
        expect(placements.get(job.placement.sessionId)?.turnClaim).toBeNull();
      }
    },
  );
});
