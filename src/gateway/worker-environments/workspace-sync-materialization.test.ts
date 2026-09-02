import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git, localWorkspaceRunner, startConnectedTunnel } from "./tunnel.test-support.js";

describe("worker tunnel manager", () => {
  it("mirrors plain workspaces and rejects escaping symlinks in a git overlay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-sync-modes-"));
    const plainPath = path.join(root, "plain");
    const gitPath = path.join(root, "git");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([
      fs.mkdir(path.join(plainPath, "nested/.git"), { recursive: true }),
      fs.mkdir(gitPath, { recursive: true }),
      fs.mkdir(remoteHome, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(plainPath, "hello.txt"), "plain\n"),
      fs.writeFile(path.join(plainPath, "nested/.git/config"), "private metadata\n"),
    ]);
    // Result staging stores refs in an unborn repository for a plain workspace.
    // A later dispatch must keep using plain-mode sync until the user creates HEAD.
    await git(plainPath, "init");
    const attachmentDirectory = "openclaw-inbound-12345678-1234-4234-8234-123456789abc";
    const userDirectories = [
      "openclaw-inbound-project",
      "openclaw-inbound-12345678-1234-4234-8234-123456789ab-",
    ];
    await Promise.all([
      fs.mkdir(path.join(plainPath, "__pycache__")),
      fs.mkdir(path.join(plainPath, attachmentDirectory)),
    ]);
    await Promise.all([
      fs.writeFile(path.join(plainPath, "__pycache__/fizzbuzz.pyc"), "derived\n"),
      fs.writeFile(path.join(plainPath, ".mypy_cache"), "derived name file\n"),
      fs.writeFile(path.join(plainPath, attachmentDirectory, "report.pdf"), "inbound original\n"),
    ]);
    for (const directory of userDirectories) {
      await fs.mkdir(path.join(plainPath, directory));
      await fs.writeFile(path.join(plainPath, directory, "report.txt"), "user project\n");
    }
    await git(gitPath, "init");
    await git(gitPath, "config", "user.name", "Worker Sync Test");
    await git(gitPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.writeFile(path.join(gitPath, "tracked.txt"), "tracked\n");
    await git(gitPath, "add", "tracked.txt");
    await git(gitPath, "commit", "-m", "base");
    await fs.symlink(path.join(root, "outside"), path.join(gitPath, "escape"));

    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startConnectedTunnel(fake, "worker:real-sync-modes", 12);

    try {
      const plain = await handle.syncWorkspace({
        localPath: plainPath,
        sessionId: "session:plain-sync",
        generation: 1,
      });
      expect(plain.mode).toBe("plain");
      await expect(
        fs.readFile(path.join(plain.remoteWorkspaceDir, "hello.txt"), "utf8"),
      ).resolves.toBe("plain\n");
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "nested/.git/config")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "__pycache__/fizzbuzz.pyc")),
      ).rejects.toThrow();
      await expect(fs.access(path.join(plain.remoteWorkspaceDir, ".mypy_cache"))).rejects.toThrow();
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, attachmentDirectory)),
      ).rejects.toThrow();
      for (const directory of userDirectories) {
        await expect(
          fs.readFile(path.join(plain.remoteWorkspaceDir, directory, "report.txt"), "utf8"),
        ).resolves.toBe("user project\n");
      }

      await expect(
        handle.syncWorkspace({
          localPath: gitPath,
          sessionId: "session:symlink-sync",
          generation: 2,
        }),
      ).rejects.toThrow("Cloud workspace symlink is not portable or escapes the sync root");
    } finally {
      await handle.stop();
      await fs.rm(root, { recursive: true });
    }
  }, 60_000);
});
