import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

const workspaceDebug = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "gateway/worker-workspace" ? { ...logger, debug: workspaceDebug } : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "includes staged local verification wall time (failure=%s)",
  async (fail) => {
    const localPath = await fs.realpath(tempDirs.make("node-staged-metrics-"));
    const stagingRoot = tempDirs.make("node-staged-metrics-upload-");
    const artifactPath = path.join(localPath, "artifact.txt");
    await fs.writeFile(artifactPath, "unchanged artifact\n");
    const actual = await readActualWorkspaceManifest({ root: localPath, baseCommit: null });
    const raw = serializeWorkerWorkspaceManifest(actual.manifest);
    const runWorkspaceCommand = vi.fn(async () => ({
      workspaceDir: "/worker/workspace",
      stdout: JSON.stringify({
        version: 1,
        manifestRef: actual.manifestRef,
        metrics: {
          contentHashCount: 0,
          contentHashDurationMs: 0,
          memoHitCount: 1,
          memoTruncatedCount: 0,
          totalDurationMs: 0,
        },
      }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      ownerSignal: new AbortController().signal,
      isOwnerCurrent: () => true,
      restoredWorkspace: {
        source: { kind: "local", path: localPath },
        remoteWorkspaceDir: "/worker/workspace",
        manifestRef: actual.manifestRef,
      },
      workspaceTransfer: {
        ...workspaceTransfer(),
        prepareUpload: () => "upload-token",
        takeUpload: () => ({
          base: actual.manifest,
          baseManifestRef: actual.manifestRef,
          baseRaw: raw,
          current: actual.manifest,
          currentManifestRef: actual.manifestRef,
          currentRaw: raw,
          stagingRoot,
        }),
      },
      runWorkspaceCommand,
      runResumeWorkspaceCommand: runWorkspaceCommand,
    });
    let measuredScanMs = 0;
    let failScan = false;
    const originalOpen = fs.open;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => measuredScanMs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === artifactPath) {
        measuredScanMs += 10;
        if (failScan) {
          throw new Error("injected final local scan failure");
        }
      }
      return await originalOpen(...args);
    });
    workspaceDebug.mockClear();
    try {
      const result = await actions.reconcileWorkspace({
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: actual.manifestRef,
        source: {
          kind: "local",
          path: localPath,
          journal: { load: () => undefined, begin: () => {}, commit: () => {}, abort: () => {} },
          stagedResult: { ref: workerWorkspaceResultRef("metrics-claim"), record: () => {} },
        },
      });
      let renewals = 0;
      const verified = verifyReconciledWorkspaceFinal(result, {
        assertActive: async () => {
          renewals += 1;
          failScan = fail && renewals === 2;
        },
        resume: async () => {},
      });
      if (fail) {
        await expect(verified).rejects.toThrow("injected final local scan failure");
      } else {
        await verified;
      }
      expect(measuredScanMs).toBeGreaterThan(0);
      expect(workspaceDebug).toHaveBeenCalledWith(
        "worker workspace reconcile completed",
        expect.objectContaining({
          outcome: fail ? "failed" : "succeeded",
          localReconciliationDurationMs: measuredScanMs,
        }),
      );
    } finally {
      open.mockRestore();
      clock.mockRestore();
    }
  },
);
