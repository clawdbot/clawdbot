import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  git,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
} from "./tunnel.test-support.js";

it("materializes a large dirty git workspace as a credential-free commit-capable clone", async ({
  signal,
  onTestFinished,
}) => {
  const lifetime = withTestDir({ prefix: "openclaw-worker-git-sync-" }, async (root) => {
    signal.throwIfAborted();
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome)]);
    await git(localPath, "init");
    await git(localPath, "config", "user.name", "Worker Sync Test");
    await git(localPath, "config", "user.email", "worker-sync@example.invalid");
    const baseFiles = new Map([
      [".gitignore", "cache/**\nprivate/**\nmedia/inbound/openclaw-staged-*/\n"],
      [".worktreeinclude", "cache/*.txt\n"],
      ["gone.txt", "delete me\n"],
      ["rename-old.txt", "rename me\n"],
      ["modified.txt", "before\n"],
      ["conflict.txt", "base\n"],
    ]);
    const largeFiles = Array.from(
      { length: 1_800 },
      (_, index) => `generated/long-worker-file-name-${String(index).padStart(4, "0")}.txt`,
    );
    for (const [index, file] of largeFiles.entries()) {
      baseFiles.set(file, `${index}\n`);
    }
    // Keep every unique blob, but seed a pack instead of paying for 1,806 loose-object writes.
    const baseRef = await git(localPath, "symbolic-ref", "HEAD");
    const baseImport = [
      `commit ${baseRef}\ncommitter Worker Sync Test <worker-sync@example.invalid> 0 +0000\ndata 5\nbase\n\n`,
      ...Array.from(
        baseFiles,
        ([file, content]) =>
          `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`,
      ),
      "done\n",
    ].join("");
    const imported = await runCommandWithTimeout(
      ["git", "-C", localPath, "fast-import", "--quiet", "--done"],
      { timeoutMs: 30_000, input: baseImport },
    );
    expect(imported, imported.stderr).toMatchObject({ code: 0, termination: "exit" });
    await git(localPath, "read-tree", "HEAD");
    await fs.mkdir(path.join(localPath, "generated"));
    const materializedFiles = [...baseFiles];
    for (let offset = 0; offset < materializedFiles.length; offset += 64) {
      await Promise.all(
        materializedFiles
          .slice(offset, offset + 64)
          .map(([file, content]) => fs.writeFile(path.join(localPath, file), content)),
      );
    }
    await git(localPath, "update-index", "--refresh");
    const firstBase = await git(localPath, "rev-parse", "HEAD");
    await fs.mkdir(path.join(localPath, "vendor/sub/.git"), { recursive: true });
    await fs.writeFile(path.join(localPath, "vendor/sub/.git/secret"), "must not transfer\n");
    await git(localPath, "update-index", "--add", "--cacheinfo", `160000,${firstBase},vendor/sub`);
    await git(localPath, "commit", "-m", "record submodule");
    const baseCommit = await git(localPath, "rev-parse", "HEAD");

    await Promise.all([
      fs.rm(path.join(localPath, "gone.txt")),
      fs.rename(path.join(localPath, "rename-old.txt"), path.join(localPath, "rename-new.txt")),
      fs.writeFile(path.join(localPath, "modified.txt"), "after\n"),
      fs.mkdir(path.join(localPath, "cache"), { recursive: true }),
      fs.mkdir(path.join(localPath, "private"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(localPath, "cache/allowed.txt"), "allowed\n"),
      fs.writeFile(path.join(localPath, "private/ignored.txt"), "private\n"),
      fs.writeFile(path.join(localPath, "ordinary-untracked.txt"), "before ignore\n"),
    ]);

    const ownership = await createStagedInputOwnershipFixture(localPath);
    const inputDirectory = stagedInputDirectory("b".repeat(64));
    const privateInput = `${inputDirectory}/input-cache.pyc`;
    await ensureStagedInputDirectory(localPath, inputDirectory);
    await fs.writeFile(path.join(localPath, privateInput), "raw input bytes");
    signal.throwIfAborted();
    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startConnectedTunnel(fake, "worker:real-git-sync", 11);

    // The first stop removes the tunnel entry; both teardown paths must join its drain.
    let stopPromise: Promise<void> | undefined;
    const stop = () => (stopPromise ??= handle.stop());
    const onAbort = () => {
      void stop().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await handle.syncWorkspace({
        localPath,
        sessionId: "session:real-git-sync",
        generation: 1,
      });
      expect(result.mode).toBe("git");
      for (const relative of ownership.unownedFiles) {
        await expect(fs.stat(path.join(result.remoteWorkspaceDir, relative))).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      }
      for (const relative of ownership.ownedFiles) {
        await expect(fs.readFile(path.join(result.remoteWorkspaceDir, relative))).resolves.toEqual(
          await fs.readFile(path.join(localPath, relative)),
        );
      }
      await createStagedInputOwnershipFixture(result.remoteWorkspaceDir);
      for (const relative of ownership.unownedFiles) {
        await fs.writeFile(
          path.join(result.remoteWorkspaceDir, relative),
          "worker project bytes\n",
        );
      }
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, privateInput), "utf8"),
      ).resolves.toBe("raw input bytes");
      await fs.writeFile(path.join(result.remoteWorkspaceDir, privateInput), "edited input bytes");
      expect(result.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const generatedNames = await fs.readdir(path.join(result.remoteWorkspaceDir, "generated"));
      expect(generatedNames.map((name) => `generated/${name}`).toSorted()).toEqual(largeFiles);
      for (let offset = 0; offset < largeFiles.length; offset += 64) {
        await Promise.all(
          largeFiles.slice(offset, offset + 64).map(async (file, index) => {
            const content = await fs.readFile(path.join(result.remoteWorkspaceDir, file), "utf8");
            expect(content, file).toBe(`${offset + index}\n`);
          }),
        );
      }
      await expect(fs.access(path.join(result.remoteWorkspaceDir, "gone.txt"))).rejects.toThrow();
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "rename-new.txt"), "utf8"),
      ).resolves.toBe("rename me\n");
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "cache/allowed.txt"), "utf8"),
      ).resolves.toBe("allowed\n");
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "private/ignored.txt")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "vendor/sub/.git/secret")),
      ).rejects.toThrow();
      expect(await git(result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(await git(result.remoteWorkspaceDir, "rev-list", "--count", "HEAD")).toBe("1");
      expect(await git(result.remoteWorkspaceDir, "remote")).toBe("");
      const status = await runCommandWithTimeout(
        ["git", "-C", result.remoteWorkspaceDir, "status", "--porcelain"],
        { timeoutMs: 30_000 },
      );
      const statusLines = status.stdout.split("\n").filter(Boolean);
      expect(statusLines).toContain(" D gone.txt");
      expect(statusLines).toContain("?? rename-new.txt");
      await git(result.remoteWorkspaceDir, "add", "-A");
      await git(result.remoteWorkspaceDir, "commit", "-m", "worker commit");
      await git(result.remoteWorkspaceDir, "merge-base", "--is-ancestor", baseCommit, "HEAD");
      await fs.mkdir(path.join(result.remoteWorkspaceDir, "private"));
      await Promise.all([
        fs.writeFile(path.join(result.remoteWorkspaceDir, "modified.txt"), "worker result\n"),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "conflict.txt"), "worker result\n"),
        fs.appendFile(
          path.join(result.remoteWorkspaceDir, ".gitignore"),
          "ordinary-untracked.txt\n",
        ),
        fs.writeFile(
          path.join(result.remoteWorkspaceDir, "ordinary-untracked.txt"),
          "still present after ignore\n",
        ),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "worker-untracked.txt"), "artifact\n"),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "cache/worker-allowed.txt"), "allowed\n"),
        fs.writeFile(
          path.join(result.remoteWorkspaceDir, "private/worker-secret.txt"),
          "private\n",
        ),
        fs.rm(path.join(result.remoteWorkspaceDir, "rename-new.txt")),
        fs.symlink("modified.txt", path.join(result.remoteWorkspaceDir, "worker-link")),
      ]);
      await fs.writeFile(path.join(localPath, "conflict.txt"), "local result\n");

      let acceptedManifestRef = result.manifestRef;
      const journal = memoryWorkspaceJournal((manifestRef) => {
        acceptedManifestRef = manifestRef;
      });
      const reconciled = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: result.remoteWorkspaceDir,
        baseManifestRef: result.manifestRef,
        journal,
      });
      expect(reconciled).toMatchObject({ changed: true });
      for (const relative of ownership.unownedFiles) {
        await expect(fs.readFile(path.join(localPath, relative), "utf8")).resolves.toBe(
          `fixture bytes: ${relative}\n`,
        );
      }
      await expect(fs.readFile(path.join(localPath, privateInput), "utf8")).resolves.toBe(
        "edited input bytes",
      );
      expect(reconciled.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
      await reconciled.verifyStable();
      await reconciled.verifyLocalStable();
      await expect(fs.readFile(path.join(localPath, "modified.txt"), "utf8")).resolves.toBe(
        "worker result\n",
      );
      await expect(fs.readFile(path.join(localPath, "worker-untracked.txt"), "utf8")).resolves.toBe(
        "artifact\n",
      );
      await expect(
        fs.readFile(path.join(localPath, "ordinary-untracked.txt"), "utf8"),
      ).resolves.toBe("still present after ignore\n");
      await expect(fs.readlink(path.join(localPath, "worker-link"))).resolves.toBe("modified.txt");
      await expect(
        fs.readFile(path.join(localPath, "cache/worker-allowed.txt"), "utf8"),
      ).resolves.toBe("allowed\n");
      await expect(fs.access(path.join(localPath, "private/worker-secret.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(localPath, "rename-new.txt"))).rejects.toThrow();
      await expect(fs.readFile(path.join(localPath, "conflict.txt"), "utf8")).resolves.toBe(
        "local result\n",
      );
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "conflict.txt"), "utf8"),
      ).resolves.toBe("local result\n");
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "private/ignored.txt")),
      ).rejects.toThrow();
      expect(await git(localPath, "rev-parse", "HEAD")).toBe(baseCommit);
      const unchanged = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: result.remoteWorkspaceDir,
        baseManifestRef: acceptedManifestRef,
        journal,
      });
      expect(unchanged).toMatchObject({ manifestRef: acceptedManifestRef, changed: false });
      await unchanged.verifyStable();
      await unchanged.verifyLocalStable();
      await fs.writeFile(path.join(result.remoteWorkspaceDir, "modified.txt"), "late write\n");
      await expect(unchanged.verifyStable()).rejects.toThrow(
        "Cloud workspace changed during final reconciliation",
      );
      await fs.writeFile(path.join(localPath, "modified.txt"), "local late write\n");
      await expect(unchanged.verifyLocalStable()).rejects.toThrow(
        "Gateway workspace changed after cloud reconciliation",
      );

      const manifestPath = path.join(
        remoteHome,
        ".openclaw-worker/manifests",
        `${result.manifestRef.slice("sha256:".length)}.json`,
      );
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        entries: Array<{ path: string }>;
      };
      expect(manifest.entries.some((entry) => entry.path === ".git")).toBe(false);
      expect(manifest.entries.some((entry) => entry.path.startsWith(".git/"))).toBe(false);

      await fs.rm(manifestPath);
      await fs.mkdir(manifestPath);
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          fs.writeFile(path.join(manifestPath, `${index}.txt`), ""),
        ),
      );
      await expect(
        handle.reconcileWorkspace({
          localPath,
          remoteWorkspaceDir: result.remoteWorkspaceDir,
          baseManifestRef: result.manifestRef,
          journal: memoryWorkspaceJournal(),
        }),
      ).rejects.toThrow("manifest transfer is not a bounded regular file");
    } finally {
      try {
        await stop();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  });
  // Vitest's timeout returns before the callback; join its work and directory cleanup.
  onTestFinished(async () => {
    await Promise.allSettled([lifetime]);
  });
  await lifetime;
}, 60_000);
