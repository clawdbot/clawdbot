import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { BUILD, transport } from "./node-worker-tunnel.test-support.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { REQUEST, seedSyncingPlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

describe("node workspace result recovery across Gateway lifetimes", () => {
  it.for([
    { name: "remote edits without restart", restart: false, remoteEdit: true, localEdit: false },
    {
      name: "unchanged workspaces after restart",
      restart: true,
      remoteEdit: false,
      localEdit: false,
    },
    { name: "remote edits after restart", restart: true, remoteEdit: true, localEdit: false },
    { name: "Gateway edits after restart", restart: true, remoteEdit: false, localEdit: true },
    {
      name: "mixed edits and an advanced Gateway HEAD after restart",
      restart: true,
      remoteEdit: true,
      localEdit: true,
      commitLocal: true,
    },
    {
      name: "conflicting edits after restart",
      restart: true,
      remoteEdit: true,
      localEdit: true,
      conflict: true,
    },
  ])(
    "collects a terminal pending result with $name",
    { timeout: 30_000 },
    (scenario, { expect, onTestFinished, signal }) => {
      const tempDirs = createTempDirTracker();
      const phases: Array<{ phase: string; elapsedMs: number }> = [];
      const startedAt = performance.now();
      const phase = (name: string) =>
        phases.push({ phase: name, elapsedMs: Math.round(performance.now() - startedAt) });
      const operation = (async () => {
        phase("setup");
        const root = await fs.realpath(tempDirs.make("node-worker-pending-recovery-"));
        const localPath = path.join(root, "gateway-workspace");
        await fs.mkdir(localPath);
        const git = async (...args: string[]) => {
          const result = await runCommandWithTimeout(["git", "-C", localPath, ...args], {
            timeoutMs: 10_000,
            signal,
          });
          expect(result.code, result.stderr).toBe(0);
          return result.stdout.trim();
        };
        await git("init", "--quiet");
        await fs.writeFile(path.join(localPath, "result.txt"), "base\n");
        // Local edits must stay inside the dispatch inventory to exercise accepted publication.
        await fs.writeFile(path.join(localPath, "local.txt"), "local base\n");
        await git("add", "result.txt", "local.txt");
        await git(
          "-c",
          "user.name=Workspace Recovery Test",
          "-c",
          "user.email=workspace-recovery@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "base",
        );

        const baseCommit = await git("rev-parse", "HEAD");
        let database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        let placements = createWorkerSessionPlacementStore({ database });
        let harness = createHarness(placements, { workspacePath: localPath });
        const environment = {
          ...harness.attached,
          nodeDeviceId: "node-1",
          sshEndpoint: null,
          bootstrapReceipt: { ...BUILD, installKind: "bundle" as const },
        };
        const createTransfer = () =>
          createNodeWorkspaceTransferService({
            temporaryRoot: path.join(root, "gateway-transfer"),
            getOwner: () => ({
              environment,
              credential: {
                ownerEpoch: environment.ownerEpoch,
                sessionId: REQUEST.sessionId,
                expiresAtMs: Date.now() + 60_000,
              },
            }),
          });
        let transfer = createTransfer();
        const server = createServer((req, res) => {
          void handleNodeWorkspaceTransferHttpRequest({
            req,
            res,
            clientIp: "127.0.0.1",
            callback: createNodeWorkspaceTransferHttpCallback(transfer),
          })
            .then((handled) => {
              if (!handled) {
                res.writeHead(404).end();
              }
            })
            .catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("workspace transfer server did not bind");
        }
        const gatewayUrl = `ws://127.0.0.1:${address.port}`;
        const runtime = new NodeWorkerWorkspaceRuntime({
          root: path.join(root, "node-workspaces"),
        });
        const nodeTransport = transport();
        nodeTransport.invoke = async (request) => {
          expect(request.isDispatchAuthorized()).toBe(true);
          if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
            return { ok: true, payloadJSON: "null" };
          }
          const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
          const result = await runtime.exec(input, request.signal, { url: gatewayUrl });
          return { ok: true, payloadJSON: JSON.stringify(result) };
        };
        const createManager = () => {
          const manager = createNodeWorkerTunnelManager({
            gatewayDeviceId: "gateway-recovery-test",
            getEnvironment: () => environment,
            listEnvironments: () => [environment],
            getTransport: () => nodeTransport,
            launchNodeWorker: vi.fn(),
            validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
            workspaceTransfer: transfer,
          });
          manager.bindWorkspaceBindingResolver(async ({ sessionId, environmentId, ownerEpoch }) => {
            const placement = placements.get(sessionId);
            if (
              !placement ||
              (placement.state !== "active" && placement.state !== "draining") ||
              placement.environmentId !== environmentId ||
              placement.activeOwnerEpoch !== ownerEpoch
            ) {
              return undefined;
            }
            return {
              localPath,
              manifestRef: placement.workspaceBaseManifestRef,
              remoteWorkspaceDir: placement.remoteWorkspaceDir,
            };
          });
          return manager;
        };
        const startRequest = {
          executionMode: "worker-turn" as const,
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          deviceId: environment.nodeDeviceId,
          sessionId: REQUEST.sessionId,
          expectedBuild: BUILD,
        };
        let manager = createManager();
        let abortedStop: Promise<void> | undefined;
        const abort = () => {
          abortedStop = manager.stopAll();
          void abortedStop.catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          phase("sync");
          const syncing = seedSyncingPlacement(placements, environment.environmentId);
          const tunnel = await manager.start(startRequest);
          const synced = await tunnel.syncWorkspace({
            localPath,
            sessionId: REQUEST.sessionId,
            generation: syncing.generation,
          });
          await expect(
            fs.readFile(path.join(synced.remoteWorkspaceDir, "result.txt"), "utf8"),
          ).resolves.toBe("base\n");
          const starting = placements.transition({
            sessionId: REQUEST.sessionId,
            from: "syncing",
            to: "starting",
            expectedGeneration: syncing.generation,
            patch: {
              workspaceBaseManifestRef: synced.manifestRef,
              remoteWorkspaceDir: synced.remoteWorkspaceDir,
            },
          });
          placements.transition({
            sessionId: REQUEST.sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: starting.generation,
            patch: { activeOwnerEpoch: environment.ownerEpoch },
          });
          const claim = placements.claimTurn({
            ...REQUEST,
            claimId: "terminal-claim",
            runId: "terminal-run",
            owner: {
              kind: "worker",
              environmentId: environment.environmentId,
              ownerEpoch: environment.ownerEpoch,
            },
          });
          if (scenario.remoteEdit) {
            await fs.writeFile(
              path.join(synced.remoteWorkspaceDir, "result.txt"),
              "worker result\n",
            );
          }
          if (scenario.localEdit) {
            await fs.writeFile(path.join(localPath, "local.txt"), "Gateway edit\n");
          }
          if ("conflict" in scenario) {
            await fs.writeFile(
              path.join(synced.remoteWorkspaceDir, "local.txt"),
              "worker conflict\n",
            );
          }
          if ("commitLocal" in scenario) {
            await git("add", "local.txt");
            await git(
              "-c",
              "user.name=Workspace Recovery Test",
              "-c",
              "user.email=workspace-recovery@example.invalid",
              "commit",
              "--quiet",
              "-m",
              "Gateway edit",
            );
            expect(await git("rev-parse", "HEAD")).not.toBe(baseCommit);
          }
          // The terminal ACK persists the fence before any workspace result is staged.
          placements.updateAckCursors({ claim, liveEvent: 1 });
          const pendingBeforeRestart = placements.listPendingWorkspaceResults();
          expect(pendingBeforeRestart).toMatchObject([
            {
              claimId: claim.claimId,
              runId: claim.runId,
              stagedResultRef: null,
              workspaceAcceptedAtMs: null,
            },
          ]);
          const originalInstanceId = placements.workspaceResultInstanceId();
          if (scenario.restart) {
            phase("reopen");
            await manager.stopAll();
            await expect(
              tunnel.runWorkspaceCommand({ argv: ["true"], transportRetry: "never" }),
            ).rejects.toThrow("authority closed");
            expect(() =>
              transfer.prepareUpload(environment.environmentId, synced.manifestRef),
            ).toThrow("context is unavailable");
            signal.throwIfAborted();
            closeOpenClawStateDatabaseForTest();
            database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
            placements = createWorkerSessionPlacementStore({ database });
            expect(placements.workspaceResultInstanceId()).not.toBe(originalInstanceId);
            expect(placements.listPendingWorkspaceResults()).toEqual(pendingBeforeRestart);
            expect(placements.get(REQUEST.sessionId)).toMatchObject({
              lastLiveEventAckCursor: 1,
              workspaceBaseManifestRef: synced.manifestRef,
            });
            transfer = createTransfer();
            manager = createManager();
            harness = createHarness(placements, { workspacePath: localPath });
          } else {
            placements.handoffWorkspaceResultRecovery(claim);
          }
          harness.markEnvironmentOwnerEpoch(environment.ownerEpoch);
          vi.mocked(harness.environments.get).mockReturnValue(environment);
          vi.mocked(harness.environments.startTunnel).mockImplementation(async () =>
            manager.start(startRequest),
          );
          vi.mocked(harness.environments.stopTunnel).mockImplementation(async () =>
            manager.stop(environment.environmentId),
          );

          phase("recover");
          await harness.service.reconcile("startup");
          signal.throwIfAborted();
          phase("assert");

          expect.soft(harness.reportWorkspaceResultRecoveryFailure.mock.calls).toEqual([]);
          expect
            .soft(await fs.readFile(path.join(localPath, "result.txt"), "utf8"))
            .toBe(scenario.remoteEdit ? "worker result\n" : "base\n");
          if (scenario.localEdit) {
            expect
              .soft(await fs.readFile(path.join(localPath, "local.txt"), "utf8"))
              .toBe("Gateway edit\n");
            expect
              .soft(
                await fs
                  .readFile(path.join(synced.remoteWorkspaceDir, "local.txt"), "utf8")
                  .catch(() => undefined),
              )
              .toBe("Gateway edit\n");
          }
          const remoteHead = await runCommandWithTimeout(
            ["git", "-C", synced.remoteWorkspaceDir, "rev-parse", "--verify", "HEAD^{commit}"],
            { timeoutMs: 10_000, signal },
          );
          expect.soft(remoteHead.code, remoteHead.stderr).toBe(0);
          expect.soft(remoteHead.stdout.trim()).toBe(baseCommit);
          if ("conflict" in scenario) {
            const stagedResultRef = "refs/openclaw/worker-results/terminal-claim";
            expect
              .soft(harness.reportWorkspaceResultConflict)
              .toHaveBeenCalledWith(
                expect.objectContaining({ paths: ["local.txt"], stagedResultRef, totalCount: 1 }),
              );
            expect(await git("show", `${stagedResultRef}:local.txt`)).toBe("worker conflict");
          } else {
            expect.soft(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
          }
          expect.soft(placements.listPendingWorkspaceResults()).toEqual([]);
          expect.soft(placements.get(REQUEST.sessionId)).toMatchObject({
            state: scenario.restart ? "reclaimed" : "active",
            turnClaim: null,
          });
        } finally {
          phase("cleanup");
          signal.removeEventListener("abort", abort);
          try {
            await (abortedStop ?? manager.stopAll());
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
            closeOpenClawStateDatabaseForTest();
          }
        }
      })();
      onTestFinished(async ({ task }) => {
        // Vitest's timeout does not join the test body. Drain its commands and cleanup
        // before deleting files or letting another case reuse the shared database owner.
        await Promise.allSettled([operation]);
        tempDirs.cleanup();
        if (task.result?.state === "fail") {
          console.info("recovery phases", scenario.name, phases);
        }
      });
      return operation;
    },
  );
});
