import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
  workerWorkspaceTransferPaths,
} from "./workspace-reconcile.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  roots.push(root);
  return root;
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
  commit?: () => void;
  abort?: () => void;
}) {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  await applyStagedWorkerWorkspace({
    ...params,
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    journal: {
      load: () => pending,
      begin: (journal) => {
        pending = journal;
        params.begin?.(journal);
      },
      commit: () => {
        params.commit?.();
        pending = undefined;
      },
      abort: () => {
        params.abort?.();
        pending = undefined;
      },
    },
  });
}

describe("worker workspace reconciliation", () => {
  it("applies changed, added, deleted, executable, binary, and symlink results", async () => {
    const local = await temporaryDirectory("workspace-local");
    const staged = await temporaryDirectory("workspace-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "keep.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(local, "delete.txt"), "remove");
    await fs.writeFile(path.join(local, "src", "script.sh"), "before");
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "src"));
    await fs.writeFile(path.join(staged, "keep.bin"), Buffer.from([0, 9, 2]));
    await fs.writeFile(path.join(staged, "added.txt"), "new");
    await fs.writeFile(path.join(staged, "src", "script.sh"), "after");
    await fs.chmod(path.join(staged, "src", "script.sh"), 0o755);
    await fs.symlink("added.txt", path.join(staged, "link.txt"));
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "keep.bin"))).resolves.toEqual(
      Buffer.from([0, 9, 2]),
    );
    await expect(fs.readFile(path.join(local, "added.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.access(path.join(local, "delete.txt"))).rejects.toThrow();
    await expect(fs.readlink(path.join(local, "link.txt"))).resolves.toBe("added.txt");
    expect((await fs.stat(path.join(local, "src", "script.sh"))).mode & 0o111).not.toBe(0);
  });

  it("preserves raw bytes when workspace attributes declare an encoding", async () => {
    const local = await temporaryDirectory("workspace-attributes");
    const staged = await temporaryDirectory("workspace-attributes-staged");
    const attributes = "encoded.txt working-tree-encoding=UTF-16LE\n";
    const baseBytes = Buffer.from("b\0a\0s\0e\0");
    const currentBytes = Buffer.from("r\0e\0m\0o\0t\0e\0");
    await gitInit(local);
    await fs.writeFile(path.join(local, ".gitattributes"), attributes);
    await fs.writeFile(path.join(local, "encoded.txt"), baseBytes);
    const base = await manifestFor(local);

    await fs.writeFile(path.join(staged, ".gitattributes"), attributes);
    await fs.writeFile(path.join(staged, "encoded.txt"), currentBytes);
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "encoded.txt"))).resolves.toEqual(currentBytes);
  });

  it("preserves an exact local-only path and rejects conflicting content", async () => {
    const local = await temporaryDirectory("workspace-local-only");
    const staged = await temporaryDirectory("workspace-local-only-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "same.txt"), "same");
    const base = { version: 1, baseCommit: null, entries: [] } satisfies WorkerWorkspaceManifest;
    await fs.writeFile(path.join(staged, "same.txt"), "same");
    const current = await manifestFor(staged);
    await applyWorkspace({ root: local, stagingRoot: staged, base, current });
    await expect(fs.readFile(path.join(local, "same.txt"), "utf8")).resolves.toBe("same");

    await fs.writeFile(path.join(local, "same.txt"), "local");
    await expect(
      applyWorkspace({ root: local, stagingRoot: staged, base, current }),
    ).rejects.toThrow("local-only path");
  });

  it("allows a remote file to replace an unchanged base directory", async () => {
    const local = await temporaryDirectory("workspace-directory-replacement");
    const staged = await temporaryDirectory("workspace-directory-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
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

  it("does not follow a base symlink while replacing it with a directory", async () => {
    const local = await temporaryDirectory("workspace-symlink-replacement");
    const staged = await temporaryDirectory("workspace-symlink-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "target"));
    await fs.writeFile(path.join(local, "target", "file.txt"), "base target");
    await fs.symlink("target", path.join(local, "entry"));
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "target"));
    await fs.writeFile(path.join(staged, "target", "file.txt"), "base target");
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "file.txt"), "remote directory");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(local, "entry", "file.txt"), "utf8")).resolves.toBe(
      "remote directory",
    );
    await expect(fs.readFile(path.join(local, "target", "file.txt"), "utf8")).resolves.toBe(
      "base target",
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
