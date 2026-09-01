import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  git,
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
} from "./tunnel.test-support.js";

it("materializes a large dirty git workspace as a credential-free commit-capable clone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-git-sync-"));
  const localPath = path.join(root, "local");
  const remoteHome = path.join(root, "remote-home");
  await Promise.all([
    fs.mkdir(path.join(localPath, "generated"), { recursive: true }),
    fs.mkdir(remoteHome, { recursive: true }),
  ]);
  await git(localPath, "init");
  await git(localPath, "config", "user.name", "Worker Sync Test");
  await git(localPath, "config", "user.email", "worker-sync@example.invalid");
  await Promise.all([
    fs.writeFile(
      path.join(localPath, ".gitignore"),
      "cache/**\nprivate/**\nmedia/inbound/openclaw-staged-*/\n",
    ),
    fs.writeFile(path.join(localPath, ".worktreeinclude"), "cache/*.txt\n"),
    fs.writeFile(path.join(localPath, "gone.txt"), "delete me\n"),
    fs.writeFile(path.join(localPath, "rename-old.txt"), "rename me\n"),
    fs.writeFile(path.join(localPath, "modified.txt"), "before\n"),
    fs.writeFile(path.join(localPath, "conflict.txt"), "base\n"),
  ]);
  const largeFiles = Array.from(
    { length: 1_800 },
    (_, index) => `generated/long-worker-file-name-${String(index).padStart(4, "0")}.txt`,
  );
  for (let offset = 0; offset < largeFiles.length; offset += 64) {
    await Promise.all(
      largeFiles
        .slice(offset, offset + 64)
        .map((file, index) => fs.writeFile(path.join(localPath, file), `${offset + index}\n`)),
    );
  }
  await git(localPath, "add", ".");
  await git(localPath, "commit", "-m", "base");
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
  const fake = localWorkspaceRunner(remoteHome);
  const { handle } = await startConnectedTunnel(fake, "worker:real-git-sync", 11);

  try {
    const result = await handle.syncWorkspace({
      localPath,
      sessionId: "session:real-git-sync",
      generation: 1,
    });
    expect(result.mode).toBe("git");
    for (const relative of ownership.unownedFiles) {
      await expect(fs.stat(path.join(result.remoteWorkspaceDir, relative))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    for (const relative of ownership.ownedFiles) {
      await expect(fs.readFile(path.join(result.remoteWorkspaceDir, relative))).resolves.toEqual(
        await fs.readFile(path.join(localPath, relative)),
      );
    }
    await createStagedInputOwnershipFixture(result.remoteWorkspaceDir);
    for (const relative of ownership.unownedFiles) {
      await fs.writeFile(path.join(result.remoteWorkspaceDir, relative), "worker project bytes\n");
    }
    await expect(
      fs.readFile(path.join(result.remoteWorkspaceDir, privateInput), "utf8"),
    ).resolves.toBe("raw input bytes");
    await fs.writeFile(path.join(result.remoteWorkspaceDir, privateInput), "edited input bytes");
    expect(result.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(
      fs.readFile(path.join(result.remoteWorkspaceDir, largeFiles[0] ?? ""), "utf8"),
    ).resolves.toBe("0\n");
    await expect(
      fs.readFile(path.join(result.remoteWorkspaceDir, largeFiles.at(-1) ?? ""), "utf8"),
    ).resolves.toBe("1799\n");
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
      fs.appendFile(path.join(result.remoteWorkspaceDir, ".gitignore"), "ordinary-untracked.txt\n"),
      fs.writeFile(
        path.join(result.remoteWorkspaceDir, "ordinary-untracked.txt"),
        "still present after ignore\n",
      ),
      fs.writeFile(path.join(result.remoteWorkspaceDir, "worker-untracked.txt"), "artifact\n"),
      fs.writeFile(path.join(result.remoteWorkspaceDir, "cache/worker-allowed.txt"), "allowed\n"),
      fs.writeFile(path.join(result.remoteWorkspaceDir, "private/worker-secret.txt"), "private\n"),
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
    await expect(fs.readFile(path.join(localPath, "ordinary-untracked.txt"), "utf8")).resolves.toBe(
      "still present after ignore\n",
    );
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
    await handle.stop();
    await fs.rm(root, { recursive: true });
  }
}, 60_000);
