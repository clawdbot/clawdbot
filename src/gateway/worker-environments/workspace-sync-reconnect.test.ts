import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  deferred,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
  waitForFast,
  waitForStarts,
} from "./tunnel.test-support.js";

const tunnelWarn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-tunnel" ? { ...logger, warn: tunnelWarn } : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker workspace reconnect", () => {
  it("reconciles a completed result across a same-owner SSH reconnect", async () => {
    const root = tempDirs.make("openclaw-worker-reconcile-reconnect-");
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome)]);
    await fs.writeFile(path.join(localPath, "result.txt"), "before\n");

    const releaseReconnect = deferred<void>();
    const resultTransfersCompleted = deferred<void>();
    let disconnectAfterManifest = false;
    let disconnected = false;
    let resultTransferCount = 0;
    const fake = localWorkspaceRunner(
      remoteHome,
      async (_argv, localArgv, options) => {
        if (!disconnected) {
          return undefined;
        }
        const result = await runCommandWithTimeout(localArgv, options);
        resultTransferCount += 1;
        if (resultTransferCount === 2) {
          resultTransfersCompleted.resolve();
        }
        return result;
      },
      (argv) => {
        if (disconnectAfterManifest && argv.at(-1)?.includes("'memo-v1'")) {
          disconnectAfterManifest = false;
          disconnected = true;
          fake.starts[0]!.process.exit(255);
        }
      },
    );
    const { handle, manager } = await startConnectedTunnel(fake, "worker:reconcile-reconnect", 13, {
      manager: {
        sleep: async (_ms, signal) => {
          await Promise.race([
            releaseReconnect.promise,
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () =>
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error("reconnect sleep aborted"),
                  ),
                { once: true },
              );
            }),
          ]);
        },
      },
    });

    try {
      const synced = await handle.syncWorkspace({
        localPath,
        sessionId: "session:reconcile-reconnect",
        generation: 1,
      });
      await fs.writeFile(path.join(synced.remoteWorkspaceDir, "result.txt"), "after\n");
      disconnectAfterManifest = true;

      const reconciling = handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        baseManifestRef: synced.manifestRef,
        journal: memoryWorkspaceJournal(),
      });
      const reconcileSettled = vi.fn();
      void reconciling.then(reconcileSettled, reconcileSettled);

      await waitForFast(() =>
        expect(manager.status("worker:reconcile-reconnect")).toBe("reconnecting"),
      );
      await resultTransfersCompleted.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(reconcileSettled).not.toHaveBeenCalled();

      releaseReconnect.resolve();
      await waitForStarts(fake.starts, 2);
      fake.starts[1]!.process.becomeReady();

      await expect(reconciling).resolves.toMatchObject({ changed: true });
      await expect(fs.readFile(path.join(localPath, "result.txt"), "utf8")).resolves.toBe(
        "after\n",
      );
      expect(tunnelWarn).toHaveBeenCalledWith(
        "worker tunnel SSH child exited during workspace operation",
        expect.objectContaining({
          environmentId: "worker:reconcile-reconnect",
          ownerEpoch: 13,
          code: 255,
          workspaceTaskCount: expect.any(Number),
        }),
      );
    } finally {
      releaseReconnect.resolve();
      await handle.stop();
    }
  });
});
