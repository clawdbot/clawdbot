import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { localWorkspaceRunner, startConnectedTunnel } from "./tunnel.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Transport = "node" | "ssh";
type MutationPhase = "none" | "upload" | "candidate" | "renewal" | "publication";

async function fixture(transport: Transport) {
  const root = await fs.realpath(tempDirs.make("workspace-staged-fence-"));
  const localPath = path.join(root, "local");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "artifact.txt"), "base\n");
  let captureCount = 0;
  let afterUpload: (() => Promise<void>) | undefined;
  let handle: Pick<WorkerWorkspaceTunnelHandle, "syncWorkspace" | "reconcileWorkspace">;
  let close: () => Promise<void>;
  if (transport === "node") {
    const owner = new AbortController();
    const identity = { environmentId: "environment", sessionId: "session", ownerEpoch: 1 };
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session" },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfers"),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
    const run: Parameters<
      typeof createNodeWorkerWorkspaceActions
    >[0]["runWorkspaceCommand"] = async (command) => {
      const uploading = command.transfer?.direction === "upload";
      if (uploading || command.capture) {
        captureCount += 1;
      }
      const result = await runtime.exec(
        {
          ...command,
          skillResources: command.skillResources?.operation,
          argv: [...command.argv],
          gatewayNamespace: "staged-fence",
          environmentId: identity.environmentId,
          sessionId: identity.sessionId,
          generation: identity.ownerEpoch,
        },
        command.signal,
        { url: server.gatewayUrl },
      );
      if (uploading) {
        await afterUpload?.();
      }
      return result;
    };
    handle = createNodeWorkerWorkspaceActions({
      ...identity,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      workspaceTransfer: service,
      runWorkspaceCommand: run,
      runResumeWorkspaceCommand: run,
    });
    close = async () => {
      owner.abort();
      await service.closeAll();
      await server.close();
    };
  } else {
    const remoteHome = path.join(root, "remote");
    await fs.mkdir(remoteHome);
    const runner = localWorkspaceRunner(
      remoteHome,
      async (argv, localArgv, options) => {
        if (
          afterUpload &&
          argv.some((arg) => arg.startsWith("--files-from=")) &&
          argv.at(-2)?.includes(":")
        ) {
          const result = await runCommandWithTimeout(localArgv, options);
          if (result.code === 0) {
            await afterUpload();
          }
          return result;
        }
        return undefined;
      },
      (argv) => {
        if (argv.at(-1)?.endsWith("'memo-v1'")) {
          captureCount += 1;
        }
      },
    );
    const tunnel = await startConnectedTunnel(runner, "environment", 1, { sharedHost: true });
    handle = tunnel.handle;
    close = async () => await tunnel.handle.stop();
  }
  try {
    const synced = await handle.syncWorkspace({
      source: { kind: "local", path: localPath },
      sessionId: "session",
      generation: 1,
    });
    const remoteArtifact = path.join(synced.remoteWorkspaceDir, "artifact.txt");
    await fs.writeFile(remoteArtifact, "worker\n");
    captureCount = 0;
    return {
      handle,
      localPath,
      remoteArtifact,
      synced,
      close,
      captureCount: () => captureCount,
      onUpload: (callback: () => Promise<void>) => {
        afterUpload = callback;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// The SSH fixture executes sh and rsync; Windows still exercises the native Node owner.
const transports: Transport[] = process.platform === "win32" ? ["node"] : ["node", "ssh"];
const cases = transports.flatMap((transport) =>
  (["none", "upload", "candidate", "renewal", "publication"] as const).map((phase) => ({
    transport,
    phase,
  })),
);

it.each(cases)(
  "$transport stages once and preserves fences for $phase mutation",
  async ({ transport, phase }: { transport: Transport; phase: MutationPhase }) => {
    const f = await fixture(transport);
    const ref = workerWorkspaceResultRef("staged-fence");
    let pending: WorkerWorkspaceReconciliationJournal | undefined;
    const begin = vi.fn((next: WorkerWorkspaceReconciliationJournal) => {
      pending = next;
    });
    const commit = vi.fn(() => {
      pending = undefined;
    });
    const record = vi.fn();
    let activePhase = phase;
    const mutate = async () => {
      await fs.writeFile(f.remoteArtifact, "late writer\n");
    };
    if (phase === "upload") {
      f.onUpload(async () => {
        if (activePhase === "upload") {
          await mutate();
        }
      });
    }
    const prepare = workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult;
    const preparing = vi
      .spyOn(workerWorkspaceResultStaging, "prepareRequestedWorkerWorkspaceResult")
      .mockImplementation(async (params) => {
        const result = await prepare(params);
        if (activePhase === "candidate") {
          await mutate();
        }
        return result;
      });
    let renewals = 0;
    const reconcile = async () => {
      const result = await f.handle.reconcileWorkspace({
        remoteWorkspaceDir: f.synced.remoteWorkspaceDir,
        baseManifestRef: f.synced.manifestRef,
        source: {
          kind: "local",
          path: f.localPath,
          journal: {
            load: () => pending,
            begin,
            commit,
            abort: () => {
              pending = undefined;
            },
          },
          stagedResult: { ref, record },
        },
      });
      return await verifyReconciledWorkspaceFinal(result, {
        assertActive: async () => {
          renewals += 1;
          if (
            (activePhase === "renewal" && renewals === 1) ||
            (activePhase === "publication" && renewals === 2)
          ) {
            await mutate();
          }
        },
        resume: async () => {},
      });
    };
    try {
      if (phase === "none") {
        await expect(reconcile()).resolves.toMatchObject({ conflictPaths: [] });
        // SSH also verifies its accepted-manifest publication; Node skips an unchanged publish.
        expect(f.captureCount()).toBe(transport === "node" ? 4 : 5);
        expect(commit).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledWith(ref);
        await expect(fs.readFile(path.join(f.localPath, "artifact.txt"), "utf8")).resolves.toBe(
          "worker\n",
        );
      } else {
        await expect(reconcile()).rejects.toMatchObject({
          message: "Cloud workspace changed during final reconciliation",
          reclaimDisposition: phase === "publication" ? "preserve-result" : "retry",
        });
        const applied = phase === "publication";
        expect(begin).toHaveBeenCalledTimes(applied ? 1 : 0);
        expect(commit).toHaveBeenCalledTimes(applied ? 1 : 0);
        expect(record).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(f.localPath, "artifact.txt"), "utf8")).resolves.toBe(
          applied ? "worker\n" : "base\n",
        );
        await expect(
          hasWorkerWorkspaceResultRef({ root: f.localPath, stagedResultRef: ref }),
        ).resolves.toBe(false);
      }
      await expect(
        hasWorkerWorkspaceResultRef({
          root: f.localPath,
          stagedResultRef: preparedWorkerWorkspaceResultRef(ref),
        }),
      ).resolves.toBe(false);
      if (phase !== "none" && phase !== "publication") {
        activePhase = "none";
        renewals = 0;
        await expect(reconcile()).resolves.toMatchObject({ conflictPaths: [] });
        expect(commit).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledWith(ref);
        expect(await fs.readFile(path.join(f.localPath, "artifact.txt"), "utf8")).toBe(
          "late writer\n",
        );
      }
    } finally {
      preparing.mockRestore();
      await f.close();
    }
  },
);

it.each(transports)(
  "%s rejects a raced non-staged transfer before local mutation",
  async (transport) => {
    const f = await fixture(transport);
    const begin = vi.fn();
    const commit = vi.fn();
    f.onUpload(async () => {
      await fs.writeFile(f.remoteArtifact, "late writer\n");
    });
    try {
      await expect(
        f.handle.reconcileWorkspace({
          remoteWorkspaceDir: f.synced.remoteWorkspaceDir,
          baseManifestRef: f.synced.manifestRef,
          source: {
            kind: "local",
            path: f.localPath,
            journal: { load: () => undefined, begin, commit, abort: () => {} },
          },
        }),
      ).rejects.toThrow("Cloud workspace changed during final reconciliation");
      expect(begin).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(f.localPath, "artifact.txt"), "utf8")).resolves.toBe(
        "base\n",
      );
    } finally {
      await f.close();
    }
  },
);
