import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
} from "./workspace-inventory-limits.js";
import { createGitTransferList, runLocalCommandToFile } from "./workspace-sync-local.js";
import { preflightWorkerWorkspace } from "./workspace-sync-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 10_000,
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("runLocalCommandToFile", () => {
  it("force-kills a command that ignores abort termination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-sync-"));
    const outputPath = path.join(root, "output");
    const readyPath = path.join(root, "ready");
    const controller = new AbortController();
    const operation = runLocalCommandToFile({
      argv: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'fs.writeFileSync(process.argv[1], "ready");',
          "setInterval(() => {}, 1000);",
        ].join(""),
        readyPath,
      ],
      outputPath,
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    try {
      await waitForFile(readyPath);
      const abortedAt = Date.now();
      controller.abort();
      await expect(operation).rejects.toThrow("Worker workspace file enumeration was aborted");
      expect(Date.now() - abortedAt).toBeLessThan(3_000);
    } finally {
      controller.abort();
      await operation.catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits derived artifacts from outbound Git file lists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-files-"));
    const files = [
      "src/keep.ts",
      "__pycache__/fizzbuzz.cpython-314.pyc",
      "generated.pyc",
      "generated.pyo",
      "cache.pyc/inside",
      "nested/.DS_Store/inside",
      ".pytest_cache/state",
      ".mypy_cache/state",
      ".ruff_cache/state",
      "node_modules/pkg/index.js",
      ".DS_Store",
    ];
    const temporaryDirectory = path.join(root, "..", `${path.basename(root)}-transfer`);
    const initOutputPath = path.join(root, "..", `${path.basename(root)}-git-init-output`);
    try {
      await Promise.all(
        files.map(async (file) => {
          await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await fs.writeFile(path.join(root, file), file);
        }),
      );
      await runLocalCommandToFile({
        argv: ["git", "-C", root, "init", "--quiet"],
        outputPath: initOutputPath,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });

      const outputPath = await createGitTransferList({
        gitRoot: root,
        temporaryDirectory,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });

      expect((await fs.readFile(outputPath, "utf8")).split("\0").filter(Boolean)).toEqual([
        "src/keep.ts",
      ]);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(temporaryDirectory, { recursive: true, force: true }),
        fs.rm(initOutputPath, { force: true }),
      ]);
    }
  });

  it("bounds raw Git candidates before materializing the eligible inventory", async () => {
    const root = tempDirs.make("openclaw-workspace-candidates-");
    const bin = path.join(root, "bin");
    const mockGit = path.join(bin, "git");
    const firstTransfer = `${root}-transfer-accepted`;
    const secondTransfer = `${root}-transfer-rejected`;
    const writeMockGit = async (count: number) => {
      await fs.writeFile(
        mockGit,
        `#!/usr/bin/env node
process.stdout.write("eligible.txt\\0".repeat(${count}));
`,
        { mode: 0o755 },
      );
    };
    try {
      await fs.mkdir(bin);
      await fs.writeFile(path.join(root, "eligible.txt"), "eligible\n");
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      await writeMockGit(MAX_WORKSPACE_INVENTORY_ENTRIES + 1);

      const acceptedPath = await createGitTransferList({
        gitRoot: root,
        temporaryDirectory: firstTransfer,
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      expect((await fs.readFile(acceptedPath, "utf8")).split("\0").filter(Boolean)).toEqual([
        "eligible.txt",
      ]);

      await writeMockGit(MAX_WORKSPACE_GIT_CANDIDATES + 1);
      await expect(
        createGitTransferList({
          gitRoot: root,
          temporaryDirectory: secondTransfer,
          signal: new AbortController().signal,
          timeoutMs: 20_000,
        }),
      ).rejects.toThrow(`exceed the ${MAX_WORKSPACE_GIT_CANDIDATES} limit`);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(firstTransfer, { recursive: true, force: true }),
        fs.rm(secondTransfer, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);
});

describe("preflightWorkerWorkspace", () => {
  it("measures the canonical Git eligibility boundary without hashing content", async () => {
    const root = tempDirs.make("openclaw-workspace-preflight-");
    const transferDirectory = `${root}-transfer`;
    try {
      await git(root, "init", "--quiet");
      await Promise.all([
        fs.writeFile(path.join(root, ".gitignore"), "ignored/**\n"),
        fs.writeFile(path.join(root, ".worktreeinclude"), "ignored/selected.txt\n"),
        fs.writeFile(path.join(root, "tracked.txt"), "tracked\n"),
        fs.writeFile(path.join(root, "missing.txt"), "sparse\n"),
      ]);
      await git(root, "add", ".gitignore", ".worktreeinclude", "tracked.txt", "missing.txt");
      await git(
        root,
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      );
      await fs.rm(path.join(root, "missing.txt"));
      await Promise.all([
        fs.writeFile(path.join(root, "ordinary.txt"), "ordinary\n"),
        fs.mkdir(path.join(root, "ignored")),
        fs.mkdir(path.join(root, "__pycache__")),
        fs.mkdir(path.join(root, "nested")),
      ]);
      await Promise.all([
        fs.writeFile(path.join(root, "ignored", "selected.txt"), "selected\n"),
        fs.writeFile(path.join(root, "ignored", "secret.txt"), "secret\n"),
        fs.writeFile(path.join(root, "__pycache__", "cache.pyc"), "derived\n"),
        fs.symlink("tracked.txt", path.join(root, "safe-link")),
      ]);
      await git(path.join(root, "nested"), "init", "--quiet");
      await fs.writeFile(path.join(root, "nested", "private.txt"), "nested\n");

      await preflightWorkerWorkspace({ localPath: root, timeoutMs: 10_000 });
      const transferPath = await createGitTransferList({
        gitRoot: root,
        temporaryDirectory: transferDirectory,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });
      const paths = new Set((await fs.readFile(transferPath, "utf8")).split("\0").filter(Boolean));

      expect(paths).toEqual(
        new Set([
          ".gitignore",
          ".worktreeinclude",
          "ignored/selected.txt",
          "ordinary.txt",
          "safe-link",
          "tracked.txt",
        ]),
      );
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(transferDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects escaping symlinks with a typed bounded error", async () => {
    const root = tempDirs.make("openclaw-workspace-symlink-");
    try {
      await git(root, "init", "--quiet");
      await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n");
      await git(root, "add", "tracked.txt");
      await git(
        root,
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      );
      await fs.symlink("../outside", path.join(root, "escape"));

      const error = await preflightWorkerWorkspace({ localPath: root, timeoutMs: 10_000 }).catch(
        (value: unknown) => value,
      );

      expect(error).toMatchObject({ name: "WorkerWorkspacePreflightError", code: "invalid_state" });
      expect((error as Error).message).toContain("escapes the sync root");
      expect((error as Error).message.length).toBeLessThanOrEqual(1_024);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves filesystem and abort failures as operational errors", async () => {
    const missingParent = tempDirs.make("openclaw-workspace-missing-");
    const root = tempDirs.make("openclaw-workspace-abort-");
    try {
      const missing = await preflightWorkerWorkspace({
        localPath: path.join(missingParent, "absent"),
      }).catch((value: unknown) => value);
      expect(missing).not.toMatchObject({ name: "WorkerWorkspacePreflightError" });
      expect(missing).toMatchObject({ code: "ENOENT" });

      await git(root, "init", "--quiet");
      const controller = new AbortController();
      controller.abort();
      const aborted = await preflightWorkerWorkspace({
        localPath: root,
        signal: controller.signal,
      }).catch((value: unknown) => value);
      expect(aborted).not.toMatchObject({ name: "WorkerWorkspacePreflightError" });
      expect((aborted as Error).message).toContain("aborted");
    } finally {
      await Promise.all([
        fs.rm(missingParent, { recursive: true, force: true }),
        fs.rm(root, { recursive: true, force: true }),
      ]);
    }
  });
});
