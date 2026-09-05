import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  readActualWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const workspaceWarning = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-workspace"
        ? { ...logger, warn: workspaceWarning }
        : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => workspaceWarning.mockReset());

async function manifestFor(root: string) {
  return (await readActualWorkspaceManifest({ root, baseCommit: null })).manifest;
}

describe("worker workspace reconciliation publication", () => {
  it("keeps local bytes and the journal pending when accepted publication is indeterminate", async () => {
    const local = tempDirs.make("openclaw-workspace-indeterminate-publication-");
    const staged = tempDirs.make("openclaw-workspace-indeterminate-publication-staged-");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    const base = await manifestFor(local);
    await Promise.all([
      fs.writeFile(path.join(staged, "result.txt"), "worker\n"),
      fs.writeFile(path.join(staged, "added.txt"), "added\n"),
    ]);
    const current = await manifestFor(staged);
    let pending: WorkerWorkspaceReconciliationJournal | undefined;
    const abort = vi.fn(() => {
      pending = undefined;
    });
    const commit = vi.fn(() => {
      pending = undefined;
    });
    const journal = {
      load: () => pending,
      begin: (value: WorkerWorkspaceReconciliationJournal) => {
        pending = value;
      },
      commit,
      abort,
    };
    const publicationFailure = new AcceptedWorkspacePublicationIndeterminateError(
      "apply",
      new Error("apply transport lost"),
      new Error("settlement timed out"),
    );

    await expect(
      applyStagedWorkerWorkspace({
        root: local,
        stagingRoot: staged,
        baseManifestRef: `sha256:${"a".repeat(64)}`,
        currentManifestRef: `sha256:${"b".repeat(64)}`,
        base,
        current,
        journal,
        publishAcceptedManifest: async () => {
          throw publicationFailure;
        },
      }),
    ).rejects.toBe(publicationFailure);

    expect(pending).toBeDefined();
    expect(commit).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("worker\n");
    await expect(fs.readFile(path.join(local, "added.txt"), "utf8")).resolves.toBe("added\n");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: pending! });
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("base\n");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
    expect(pending).toBeDefined();
    journal.abort();
    expect(pending).toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("rolls local bytes back immediately when accepted publication fails definitively", async () => {
    const local = tempDirs.make("openclaw-workspace-definitive-publication-failure-");
    const staged = tempDirs.make("openclaw-workspace-definitive-publication-failure-staged-");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "result.txt"), "worker\n");
    const current = await manifestFor(staged);
    let pending: WorkerWorkspaceReconciliationJournal | undefined;
    const abort = vi.fn(() => {
      pending = undefined;
    });

    await expect(
      applyStagedWorkerWorkspace({
        root: local,
        stagingRoot: staged,
        baseManifestRef: `sha256:${"a".repeat(64)}`,
        currentManifestRef: `sha256:${"b".repeat(64)}`,
        base,
        current,
        journal: {
          load: () => pending,
          begin: (value) => {
            pending = value;
          },
          commit: () => {
            pending = undefined;
          },
          abort,
        },
        publishAcceptedManifest: async () => {
          throw new Error("publication rejected");
        },
      }),
    ).rejects.toThrow("publication rejected");

    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("base\n");
    expect(pending).toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each([
    ["preserves committed results and recovery refs when scratch cleanup fails", true, false],
    ["preserves publication failures and rollback when scratch cleanup fails", true, true],
    ["removes disposable scratch without warning when cleanup succeeds", false, false],
  ])("%s", async (_name, cleanupFails, publicationFails) => {
    const local = tempDirs.make("openclaw-workspace-result-cleanup-local-");
    const payload = tempDirs.make("openclaw-workspace-result-cleanup-payload-");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    const base = await readActualWorkspaceManifest({ root: local, baseCommit: null });
    const current = await readActualWorkspaceManifest({ root: payload, baseCommit: null });
    const publicationError = new Error("accepted publication rejected");
    const cleanupError = new Error("scratch removal failed");
    const ref = workerWorkspaceResultRef("claim-staging-cleanup");
    const record = vi.fn();
    const commit = vi.fn();
    const abort = vi.fn();
    const prepared = await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.manifestRef,
        journal: { load: () => undefined, begin: () => {}, commit, abort },
        stagedResult: { ref, record },
      },
      stagingRoot: payload,
      currentManifestRef: current.manifestRef,
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      publishAcceptedManifest: async () => {
        if (publicationFails) {
          throw publicationError;
        }
      },
    });
    const remove = fs.rm;
    const scratch = tempDirs.make("openclaw-workspace-result-cleanup-scratch-");
    const makeScratch = vi.spyOn(fs, "mkdtemp").mockResolvedValueOnce(scratch);
    const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === scratch) {
        if (cleanupFails) {
          throw cleanupError;
        }
      }
      return await remove(target, options);
    });

    try {
      await expect(
        hasWorkerWorkspaceResultRef({
          root: local,
          stagedResultRef: preparedWorkerWorkspaceResultRef(ref),
        }),
      ).resolves.toBe(true);
      const finalized = verifyReconciledWorkspaceFinal(
        {
          ...prepared,
          manifestRef: current.manifestRef,
          changed: true,
          verifyStable: async () => {},
        },
        { assertActive: async () => {}, resume: async () => {} },
      );
      if (publicationFails) {
        await expect(finalized).rejects.toBe(publicationError);
        expect(abort).toHaveBeenCalledOnce();
      } else {
        await expect(finalized).resolves.toMatchObject({ manifestRef: current.manifestRef });
        expect(commit).toHaveBeenCalledOnce();
      }
      await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe(
        publicationFails ? "base\n" : "worker\n",
      );
      await expect(
        hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: ref }),
      ).resolves.toBe(!publicationFails);
      await expect(
        hasWorkerWorkspaceResultRef({
          root: local,
          stagedResultRef: preparedWorkerWorkspaceResultRef(ref),
        }),
      ).resolves.toBe(false);
      expect(record).toHaveBeenCalledTimes(publicationFails ? 0 : 1);
      expect(workspaceWarning).toHaveBeenCalledTimes(cleanupFails ? 1 : 0);
      if (cleanupFails) {
        expect(workspaceWarning).toHaveBeenCalledWith(
          "worker workspace staging cleanup failed: scratch removal failed",
        );
        await expect(fs.access(scratch)).resolves.toBeUndefined();
      } else {
        await expect(fs.access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      makeScratch.mockRestore();
      removeSpy.mockRestore();
      await remove(scratch, { recursive: true, force: true });
    }
  });
});
