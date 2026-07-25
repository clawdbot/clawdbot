import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceMatchesManifest,
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.unstubAllEnvs();
});

async function temporaryDirectory(name: string): Promise<string> {
  return tempDirs.make(`openclaw-${name}-`);
}

async function gitInit(root: string): Promise<void> {
  const result = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(result.code).toBe(0);
}

async function manifestFor(root: string): Promise<WorkerWorkspaceManifest> {
  const entries: WorkerWorkspaceManifestEntry[] = [];
  const directories: string[] = [];
  const walk = async (relativeDirectory: string) => {
    for (const name of (await fs.readdir(path.join(root, relativeDirectory))).toSorted()) {
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        directories.push(relative);
        await walk(relative);
      } else if (stats.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "symlink",
          mode: 0o777,
          target: await fs.readlink(absolute),
        });
      } else {
        const content = await fs.readFile(absolute);
        entries.push({
          path: relative,
          type: "file",
          mode: (stats.mode & 0o111) === 0 ? 0o644 : 0o755,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  };
  await walk("");
  return { version: 1, baseCommit: null, entries, directories };
}

function encodeManifest(value: unknown) {
  const raw = JSON.stringify(value);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

async function applyWorkspace(params: {
  root: string;
  stagingRoot: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  begin?: (journal: WorkerWorkspaceReconciliationJournal) => void;
  commit?: (manifestRef: string) => void;
  abort?: () => void;
}) {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  return await applyStagedWorkerWorkspace({
    ...params,
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    journal: {
      load: () => pending,
      begin: (journal) => {
        pending = journal;
        params.begin?.(journal);
      },
      commit: (manifestRef) => {
        params.commit?.(manifestRef);
        pending = undefined;
      },
      abort: () => {
        params.abort?.();
        pending = undefined;
      },
    },
  });
}

describe("worker workspace reconciliation recovery", () => {
  it("does not follow a symlinked ancestor while recovering journal directories", async () => {
    const local = await temporaryDirectory("workspace-directory-recovery-symlink");
    const staged = await temporaryDirectory("workspace-directory-recovery-symlink-staged");
    const outside = await temporaryDirectory("workspace-directory-recovery-symlink-outside");
    await fs.mkdir(path.join(local, "parent", "nested"), { recursive: true });
    const base = await manifestFor(local);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
      begin: (value) => {
        journal = value;
      },
    });
    await fs.symlink(outside, path.join(local, "parent"));

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending: parent");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("keeps an unsupported local node as a conflict", async () => {
    const local = await temporaryDirectory("workspace-unsupported-node-conflict");
    const staged = await temporaryDirectory("workspace-unsupported-node-conflict-staged");
    const base = await manifestFor(local);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    await fs.writeFile(path.join(staged, "result.pipe"), "worker file");

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.pipe"]);
    expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
    expect(applied.manifest.entries).toEqual([]);
  });

  it("does not block when an expected file is replaced by a FIFO", async () => {
    const local = await temporaryDirectory("workspace-expected-file-fifo");
    const expected = await temporaryDirectory("workspace-expected-file-fifo-manifest");
    await fs.writeFile(path.join(expected, "result.pipe"), "expected");
    const manifest = await manifestFor(expected);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);

    await expect(assertWorkspaceMatchesManifest({ root: local, manifest })).rejects.toThrow(
      "Gateway workspace changed after cloud dispatch: result.pipe",
    );
  });

  it("keeps an oversized local version as a conflict", async () => {
    const local = await temporaryDirectory("workspace-oversized-node-conflict");
    const staged = await temporaryDirectory("workspace-oversized-node-conflict-staged");
    const base = await manifestFor(local);
    const oversizedPath = path.join(local, "result.bin");
    await fs.writeFile(path.join(staged, "result.bin"), "worker file");
    await fs.writeFile(oversizedPath, "");
    await fs.truncate(oversizedPath, MAX_RECONCILIATION_FILE_BYTES + 1);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.bin"]);
    await expect(fs.stat(oversizedPath)).resolves.toMatchObject({
      size: MAX_RECONCILIATION_FILE_BYTES + 1,
    });
    expect(applied.manifest.entries).toEqual([]);
  });

  it("omits an unrelated oversized local file while applying other worker changes", async () => {
    const local = await temporaryDirectory("workspace-oversized-local-only");
    const staged = await temporaryDirectory("workspace-oversized-local-only-staged");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(staged, "result.txt"), "worker\n");
    const base = await manifestFor(local);
    const oversizedPath = path.join(local, "local-only.bin");
    await fs.writeFile(oversizedPath, "");
    await fs.truncate(oversizedPath, MAX_RECONCILIATION_FILE_BYTES + 1);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("worker\n");
    await expect(fs.stat(oversizedPath)).resolves.toMatchObject({
      size: MAX_RECONCILIATION_FILE_BYTES + 1,
    });
    expect(applied.manifest.entries.map((entry) => entry.path)).toEqual(["result.txt"]);
  });

  it("allows a remote file to replace a base directory containing only derived entries", async () => {
    const local = await temporaryDirectory("workspace-derived-directory-replacement");
    const staged = await temporaryDirectory("workspace-derived-directory-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src", "pkg", "__pycache__"), { recursive: true });
    await fs.mkdir(path.join(local, "src", "empty"));
    await fs.writeFile(path.join(local, "src", "pkg", "__pycache__", "old.pyc"), "local cache");
    const rawBase = await manifestFor(local);
    const encodedBase = encodeManifest({
      version: rawBase.version,
      baseCommit: rawBase.baseCommit,
      entries: [
        ...(rawBase.directories ?? []).map((entryPath) => ({
          path: entryPath,
          type: "directory",
          mode: 0o700,
        })),
        ...rawBase.entries,
      ].toSorted((left, right) => left.path.localeCompare(right.path)),
    });
    const base = parseWorkerWorkspaceManifest(encodedBase.raw, encodedBase.ref);
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("keeps a current empty directory represented when it gains derived residue", async () => {
    const local = await temporaryDirectory("workspace-current-directory-derived-residue");
    const staged = await temporaryDirectory("workspace-current-directory-derived-residue-staged");
    await fs.mkdir(path.join(local, "cache-holder"));
    await fs.mkdir(path.join(staged, "cache-holder"));
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(staged, "result.txt"), "worker\n");
    const base = await manifestFor(local);
    const current = await manifestFor(staged);
    await fs.mkdir(path.join(local, "cache-holder", "__pycache__"));
    await fs.writeFile(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "derived");

    const applied = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(applied.conflictPaths).toEqual([]);
    expect(applied.manifest.directories).toContain("cache-holder");
    await expect(
      fs.readFile(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "utf8"),
    ).resolves.toBe("derived");
  });

  it("allows a remote file to replace a base directory with a new cache-only subtree", async () => {
    const local = await temporaryDirectory("workspace-new-derived-subtree-replacement");
    const staged = await temporaryDirectory("workspace-new-derived-subtree-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "tmp", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "tmp", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("allows a remote file to replace a new cache-only directory", async () => {
    const local = await temporaryDirectory("workspace-new-derived-directory-replacement");
    const staged = await temporaryDirectory("workspace-new-derived-directory-replacement-staged");
    await gitInit(local);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "tmp", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "tmp", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("rolls back a remote file that replaced a base directory", async () => {
    const local = await temporaryDirectory("workspace-directory-rollback");
    const staged = await temporaryDirectory("workspace-directory-rollback-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        commit: () => {
          throw new Error("placement write failed");
        },
      }),
    ).rejects.toThrow("placement write failed");

    await expect(fs.readFile(path.join(local, "src", "old.txt"), "utf8")).resolves.toBe("base");
  });

  it("restores a file over a directory containing only derived descendants", async () => {
    const local = await temporaryDirectory("workspace-directory-recovery-cache");
    const staged = await temporaryDirectory("workspace-directory-recovery-cache-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "src"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "src"));
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    await fs.mkdir(path.join(local, "src", "pkg", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "pkg", "__pycache__", "remote.pyc"), "local cache");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("base");
  });

  it("does not follow a base symlink while replacing it with a directory", async () => {
    const local = await temporaryDirectory("workspace-symlink-replacement");
    const staged = await temporaryDirectory("workspace-symlink-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "target"));
    await fs.mkdir(path.join(local, "target", "nested", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "target", "file.txt"), "base target");
    await fs.writeFile(
      path.join(local, "target", "nested", "__pycache__", "cache.pyc"),
      "outside cache",
    );
    await fs.symlink("target", path.join(local, "entry"));
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "target"));
    await fs.writeFile(path.join(staged, "target", "file.txt"), "base target");
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested"), "remote directory");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(local, "entry", "nested"), "utf8")).resolves.toBe(
      "remote directory",
    );
    await expect(fs.readFile(path.join(local, "target", "file.txt"), "utf8")).resolves.toBe(
      "base target",
    );
    await expect(
      fs.readFile(path.join(local, "target", "nested", "__pycache__", "cache.pyc"), "utf8"),
    ).resolves.toBe("outside cache");
  });

  it("materializes descendants when replacing a base file with a directory", async () => {
    const local = await temporaryDirectory("workspace-file-directory-replacement");
    const staged = await temporaryDirectory("workspace-file-directory-replacement-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "entry"), "base file");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested.txt"), "worker");
    const current = await manifestFor(staged);

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(local, "entry", "nested.txt"), "utf8")).resolves.toBe(
      "worker",
    );
  });

  it("does not follow a local-only symlink ancestor omitted from older manifests", async () => {
    const local = await temporaryDirectory("workspace-local-only-symlink-ancestor");
    const staged = await temporaryDirectory("workspace-local-only-symlink-ancestor-staged");
    const outside = await temporaryDirectory("workspace-local-only-symlink-ancestor-outside");
    await fs.writeFile(path.join(outside, "worker.txt"), "outside local");
    await fs.symlink(outside, path.join(local, "link"));
    await fs.mkdir(path.join(staged, "link"));
    await fs.writeFile(path.join(staged, "link", "worker.txt"), "worker result");
    const current = await manifestFor(staged);
    current.directories = [];

    const result = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base: { version: 1, baseCommit: null, entries: [], directories: [] },
      current,
    });

    expect(result.conflictPaths).toEqual(["link"]);
    expect((await fs.lstat(path.join(local, "link"))).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(outside, "worker.txt"), "utf8")).resolves.toBe(
      "outside local",
    );
  });

  it("keeps a local descendant when both sides replace a base file with a directory", async () => {
    const local = await temporaryDirectory("workspace-file-to-directory-conflict");
    const staged = await temporaryDirectory("workspace-file-to-directory-conflict-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "entry"), "base file");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"));
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "nested.txt"), "local");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual(["entry/nested.txt"]);
    await expect(fs.readFile(path.join(local, "entry", "nested.txt"), "utf8")).resolves.toBe(
      "local",
    );
  });

  it("accepts a convergent directory-to-file replacement without reading old descendants", async () => {
    const local = await temporaryDirectory("workspace-directory-to-file-noop");
    const staged = await temporaryDirectory("workspace-directory-to-file-noop-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "nested.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "entry"), "same replacement");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"), { recursive: true });
    await fs.writeFile(path.join(local, "entry"), "same replacement");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "entry"), "utf8")).resolves.toBe("same replacement");
  });

  it("keeps a locally replaced unchanged ancestor when the worker adds a child", async () => {
    const local = await temporaryDirectory("workspace-unchanged-ancestor-conflict");
    const staged = await temporaryDirectory("workspace-unchanged-ancestor-conflict-staged");
    await gitInit(local);
    await Promise.all([fs.mkdir(path.join(local, "entry")), fs.mkdir(path.join(staged, "entry"))]);
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "entry", "new.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"), { recursive: true });
    await fs.writeFile(path.join(local, "entry"), "local replacement");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual(["entry"]);
    await expect(fs.readFile(path.join(local, "entry"), "utf8")).resolves.toBe("local replacement");
  });

  it("merges independent children added under the same new directory", async () => {
    const local = await temporaryDirectory("workspace-independent-directory-additions");
    const staged = await temporaryDirectory("workspace-independent-directory-additions-staged");
    await gitInit(local);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "cloud.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "local.txt"), "local");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "entry", "cloud.txt"), "utf8")).resolves.toBe(
      "worker",
    );
    await expect(fs.readFile(path.join(local, "entry", "local.txt"), "utf8")).resolves.toBe(
      "local",
    );
  });

  it("rolls back atomically when durable manifest acceptance fails", async () => {
    const local = await temporaryDirectory("workspace-rollback");
    const staged = await temporaryDirectory("workspace-rollback-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "file.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "file.txt"), "remote");
    await fs.writeFile(path.join(staged, "added.txt"), "remote");
    const current = await manifestFor(staged);
    let aborted = false;

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        commit: () => {
          throw new Error("placement write failed");
        },
        abort: () => {
          aborted = true;
        },
      }),
    ).rejects.toThrow("placement write failed");
    expect(aborted).toBe(true);
    await expect(fs.readFile(path.join(local, "file.txt"), "utf8")).resolves.toBe("base");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
  });

  it("refuses to roll back a file-to-directory replacement over a later local child", async () => {
    const local = await temporaryDirectory("workspace-file-directory-recovery-local-child");
    const staged = await temporaryDirectory("workspace-file-directory-recovery-local-child-staged");
    await fs.writeFile(path.join(local, "entry"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "cloud.txt"), "worker");
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
      begin: (value) => {
        journal = value;
      },
    });
    await fs.writeFile(path.join(local, "entry", "local.txt"), "later local");

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("entry");
    await expect(fs.readFile(path.join(local, "entry", "local.txt"), "utf8")).resolves.toBe(
      "later local",
    );
  });

  it("recovers SHA-1 journals under SHA-256 defaults before and after partial apply", async () => {
    vi.stubEnv("GIT_DEFAULT_HASH", "sha256");
    const local = await temporaryDirectory("workspace-crash-recovery");
    const staged = await temporaryDirectory("workspace-crash-recovery-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "file.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "file.txt"), "remote");
    await fs.writeFile(path.join(staged, "added.txt"), "remote");
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    expect(journal).toBeDefined();
    expect(journal?.baseTree).toMatch(/^[a-f0-9]{40}$/u);
    // Simulate interruption after the addition but before the modification.
    await fs.writeFile(path.join(local, "file.txt"), "base");
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });
    await expect(fs.readFile(path.join(local, "file.txt"), "utf8")).resolves.toBe("base");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await fs.rm(path.join(local, "file.txt"));
    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending");
    await expect(fs.access(path.join(local, "file.txt"))).rejects.toThrow();
  });

  it("ignores derived paths in a journal created before the exclusion", async () => {
    const local = await temporaryDirectory("workspace-derived-recovery");
    const staged = await temporaryDirectory("workspace-derived-recovery-staged");
    await gitInit(local);
    await Promise.all([
      fs.writeFile(path.join(local, "file.txt"), "base"),
      fs.writeFile(path.join(local, ":literal.ts"), "base literal"),
    ]);
    const base = await manifestFor(local);
    await Promise.all([
      fs.writeFile(path.join(staged, "file.txt"), "remote"),
      fs.writeFile(path.join(staged, ":literal.ts"), "remote literal"),
    ]);
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    expect(journal).toBeDefined();
    expect(journal!.baseEntries.map((entry) => entry.path)).toContain(":literal.ts");
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("remote literal");
    const withLegacyDerivedPath = (entry: WorkerWorkspaceManifestEntry) => {
      if (entry.path !== "file.txt") {
        return entry;
      }
      const legacyEntry = structuredClone(entry);
      legacyEntry.path = "__pycache__/file.pyc";
      return legacyEntry;
    };
    const legacyJournal = {
      ...journal!,
      baseEntries: journal!.baseEntries.map(withLegacyDerivedPath),
      appliedEntries: journal!.appliedEntries.map(withLegacyDerivedPath),
    } satisfies WorkerWorkspaceReconciliationJournal;
    await fs.mkdir(path.join(local, "__pycache__"));
    await fs.writeFile(path.join(local, "__pycache__/file.pyc"), "local cache");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: legacyJournal });

    expect(await fs.readFile(path.join(local, "file.txt"), "utf8")).toBe("remote");
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("base literal");
    await expect(fs.readFile(path.join(local, "__pycache__/file.pyc"), "utf8")).resolves.toBe(
      "local cache",
    );
  });

  it("does not follow a symlink-raced ancestor during Git patch application", async () => {
    const local = await temporaryDirectory("workspace-symlink-race");
    const staged = await temporaryDirectory("workspace-symlink-race-staged");
    const outside = await temporaryDirectory("workspace-symlink-race-outside");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "file.txt"), "base");
    await fs.mkdir(path.join(staged, "src"));
    await fs.writeFile(path.join(staged, "src", "file.txt"), "remote");
    await fs.writeFile(path.join(outside, "file.txt"), "outside");
    const base = await manifestFor(local);
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        begin: () => {
          renameSync(path.join(local, "src"), path.join(local, "original-src"));
          symlinkSync(outside, path.join(local, "src"));
        },
      }),
    ).rejects.toThrow();
    await expect(fs.readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside");
  });

  it("authenticates manifests, normalizes Git modes, and rejects escaping symlinks", () => {
    const value = {
      version: 1,
      baseCommit: null,
      entries: [
        { path: "dir", type: "directory", mode: 0o700 },
        { path: "dir/file", type: "file", mode: 0o600, size: 1, sha256: "a".repeat(64) },
      ],
    };
    const encoded = encodeManifest(value);
    expect(parseWorkerWorkspaceManifest(encoded.raw, encoded.ref).entries).toEqual([
      { path: "dir/file", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
    ]);
    const legacyDerived = encodeManifest({
      version: 1,
      baseCommit: null,
      entries: [
        { path: "__pycache__", type: "directory", mode: 0o700 },
        {
          path: "__pycache__/fizzbuzz.pyc",
          type: "file",
          mode: 0o600,
          size: 1,
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(parseWorkerWorkspaceManifest(legacyDerived.raw, legacyDerived.ref)).toMatchObject({
      entries: [],
      directories: [],
    });
    expect(() => parseWorkerWorkspaceManifest(`${encoded.raw} `, encoded.ref)).toThrow("digest");
    for (const target of ["../outside", "..\\outside", "C:/outside"]) {
      const invalid = encodeManifest({
        version: 1,
        baseCommit: null,
        entries: [{ path: "link", type: "symlink", mode: 0o777, target }],
      });
      expect(() => parseWorkerWorkspaceManifest(invalid.raw, invalid.ref)).toThrow("symlink");
    }
  });

  it("returns only changed current payload paths", () => {
    const file = (
      entryPath: string,
      hash: string,
    ): Extract<WorkerWorkspaceManifestEntry, { type: "file" }> => ({
      path: entryPath,
      type: "file",
      mode: 0o644,
      size: 1,
      sha256: hash.repeat(64),
    });
    const base = {
      version: 1,
      baseCommit: null,
      entries: [file("a", "a"), file("b", "b")],
    } satisfies WorkerWorkspaceManifest;
    const current = {
      version: 1,
      baseCommit: null,
      entries: [file("a", "c"), file("c", "d")],
    } satisfies WorkerWorkspaceManifest;
    expect(workerWorkspaceTransferPaths(current, base)).toEqual(["a", "c"]);

    const oversized = file("large", "e");
    oversized.size = MAX_RECONCILIATION_FILE_BYTES + 1;
    expect(() =>
      workerWorkspaceTransferPaths(
        { version: 1, baseCommit: null, entries: [oversized] },
        { version: 1, baseCommit: null, entries: [] },
      ),
    ).toThrow("too large");
  });
});
