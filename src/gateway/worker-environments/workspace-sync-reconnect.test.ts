import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import {
  deferred,
  fakeRunner,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
  waitForFast,
  waitForStarts,
} from "./tunnel.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";

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
  beforeEach(() => {
    tunnelWarn.mockClear();
  });

  it("reconciles a completed result across a same-owner SSH reconnect", async () => {
    const root = tempDirs.make("openclaw-worker-reconcile-reconnect-");
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome)]);
    await fs.writeFile(path.join(localPath, "result.txt"), "before\n");

    const releaseReconnect = deferred<void>();
    let disconnectAfterManifest = false;
    let manifestCount = 0;
    const fake = localWorkspaceRunner(remoteHome, undefined, (argv) => {
      if (disconnectAfterManifest && argv.at(-1)?.includes("'memo-v1'") && ++manifestCount === 1) {
        disconnectAfterManifest = false;
        fake.starts[0]!.process.exit(255);
      }
    });
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
      const reconciliation = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        baseManifestRef: synced.manifestRef,
        journal: memoryWorkspaceJournal(),
      });
      const quiescence: WorkerWorkspaceQuiescence = {
        assertActive: async () => {
          const result = await handle.runWorkspaceCommand({
            transportRetry: "never",
            argv: ["pwd"],
          });
          expect(result.code).toBe(0);
        },
        resume: async () => {},
      };
      manifestCount = 0;
      disconnectAfterManifest = true;
      const finalizing = verifyReconciledWorkspaceFinal(reconciliation, quiescence);
      const finalizationSettled = vi.fn();
      void finalizing.then(finalizationSettled, finalizationSettled);

      await waitForFast(() =>
        expect(manager.status("worker:reconcile-reconnect")).toBe("reconnecting"),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(finalizationSettled).not.toHaveBeenCalled();

      releaseReconnect.resolve();
      await waitForStarts(fake.starts, 2);
      fake.starts[1]!.process.becomeReady();

      await expect(finalizing).resolves.toBeDefined();
      await expect(fs.readFile(path.join(localPath, "result.txt"), "utf8")).resolves.toBe(
        "after\n",
      );
    } finally {
      releaseReconnect.resolve();
      await handle.stop();
    }
  });

  it("waits for a same-owner reconnect before initial workspace sync", async () => {
    const root = tempDirs.make("openclaw-worker-sync-reconnect-");
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome)]);
    await fs.writeFile(path.join(localPath, "input.txt"), "ready\n");

    const releaseReconnect = deferred<void>();
    const fake = localWorkspaceRunner(remoteHome);
    const { handle, manager } = await startConnectedTunnel(fake, "worker:sync-reconnect", 15, {
      manager: {
        sleep: async () => await releaseReconnect.promise,
      },
    });

    try {
      fake.starts[0]!.process.exit(255);
      await waitForFast(() => expect(manager.status("worker:sync-reconnect")).toBe("reconnecting"));
      const syncing = handle.syncWorkspace({
        localPath,
        sessionId: "session:sync-reconnect",
        generation: 1,
      });
      const syncSettled = vi.fn();
      void syncing.then(syncSettled, syncSettled);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(syncSettled).not.toHaveBeenCalled();

      releaseReconnect.resolve();
      await waitForStarts(fake.starts, 2);
      fake.starts[1]!.process.becomeReady();
      await expect(syncing).resolves.toMatchObject({
        mode: "plain",
        remoteWorkspaceDir: expect.any(String),
        manifestRef: expect.stringMatching(/^sha256:/u),
      });
    } finally {
      releaseReconnect.resolve();
      await handle.stop();
    }
  });

  it("logs an in-flight child exit and the reconnect attempt before readiness", async () => {
    const commandStarted = deferred<void>();
    const releaseCommand = deferred<void>();
    const fake = fakeRunner(async (argv) => {
      if (argv.at(-1)?.includes("'pwd'")) {
        commandStarted.resolve();
        await releaseCommand.promise;
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:reconnect-diagnostics", 14, {
      manager: { sleep: async () => {} },
    });

    try {
      const running = handle.runWorkspaceCommand({ transportRetry: "idempotent", argv: ["pwd"] });
      await commandStarted.promise;
      fake.starts[0]!.process.exit(255, "ssh transport closed");

      await waitForStarts(fake.starts, 2);
      expect(tunnelWarn).toHaveBeenCalledWith(
        "worker tunnel SSH child exited during workspace operation",
        expect.objectContaining({
          environmentId: "worker:reconnect-diagnostics",
          ownerEpoch: 14,
          exitCode: 255,
          signal: null,
          stderrTail: "ssh transport closed",
          workspaceTaskCount: 1,
        }),
      );
      expect(tunnelWarn).toHaveBeenCalledWith(
        "worker tunnel reconnect attempt started",
        expect.objectContaining({
          environmentId: "worker:reconnect-diagnostics",
          ownerEpoch: 14,
          attempt: 2,
          status: "reconnecting",
          port: expect.any(Number),
          workspaceTaskCount: 1,
        }),
      );
      fake.starts[1]!.process.becomeReady();
      releaseCommand.resolve();
      await expect(running).resolves.toMatchObject({ code: 0 });
    } finally {
      releaseCommand.resolve();
      await handle.stop();
    }
  });
});
