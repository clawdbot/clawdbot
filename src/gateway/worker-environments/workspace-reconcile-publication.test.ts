import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  applyStagedWorkerWorkspace,
  readActualWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function temporaryDirectory(name: string): Promise<string> {
  return await fs.realpath(tempDirs.make(`openclaw-${name}-`));
}

async function manifestFor(root: string) {
  return (await readActualWorkspaceManifest({ root, baseCommit: null })).manifest;
}

describe("worker workspace reconciliation publication", () => {
  it("keeps local bytes and the journal pending when accepted publication is indeterminate", async () => {
    const local = await temporaryDirectory("workspace-indeterminate-publication");
    const staged = await temporaryDirectory("workspace-indeterminate-publication-staged");
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
    const local = await temporaryDirectory("workspace-definitive-publication-failure");
    const staged = await temporaryDirectory("workspace-definitive-publication-failure-staged");
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
});
