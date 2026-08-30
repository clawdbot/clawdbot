import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
} from "./workspace-inventory-limits.js";
import {
  createWorkspaceGitTransferList,
  filterExistingGitTransferList,
  runWorkspaceInventoryCommandToFile,
} from "./workspace-sync-inventory.js";
import { preflightWorkerWorkspace } from "./workspace-sync-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function injectPositiveShortWrite(targetPath: string): () => boolean {
  const originalOpen = fs.open.bind(fs);
  let shortWriteObserved = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (
      typeof args[0] !== "string" ||
      path.resolve(args[0]) !== path.resolve(targetPath) ||
      args[1] !== "wx"
    ) {
      return handle;
    }

    let injectShortWrite = true;
    const injectedHandle = Object.create(handle) as typeof handle;
    injectedHandle.close = handle.close.bind(handle);
    injectedHandle.write = (async (
      data: string | NodeJS.ArrayBufferView,
      offsetOrPosition: number | null = null,
      length?: number | null,
      position?: number | null,
    ) => {
      const buffer =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const offset = typeof data === "string" ? 0 : (offsetOrPosition ?? 0);
      const requested =
        typeof data === "string" ? buffer.length : (length ?? buffer.length - offset);
      const filePosition = typeof data === "string" ? offsetOrPosition : position;
      const writeLength = injectShortWrite ? Math.max(1, Math.floor(requested / 2)) : requested;
      injectShortWrite = false;
      shortWriteObserved ||= writeLength < requested;
      return await handle.write(buffer, offset, writeLength, filePosition);
    }) as typeof handle.write;
    injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
      const buffer =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await injectedHandle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten === 0) {
          throw new Error("injected file write made no progress");
        }
        offset += bytesWritten;
      }
    }) as typeof handle.writeFile;
    return injectedHandle;
  });
  return () => shortWriteObserved;
}

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

describe("runWorkspaceInventoryCommandToFile", () => {
  it("fully persists bounded stdout after a positive short write", async () => {
    const root = tempDirs.make("openclaw-workspace-command-short-write-");
    const outputPath = path.join(root, "output");
    const expected = Buffer.from("bounded workspace inventory output\n");
    const shortWriteObserved = injectPositiveShortWrite(outputPath);

    await runWorkspaceInventoryCommandToFile({
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", expected.toString()],
      outputPath,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      maxOutputBytes: expected.length,
    });

    expect(shortWriteObserved()).toBe(true);
    await expect(fs.readFile(outputPath)).resolves.toEqual(expected);
  });

  it("fully persists a buffered Git transfer list after a positive short write", async () => {
    const root = tempDirs.make("openclaw-workspace-list-short-write-");
    const temporaryDirectory = `${root}-transfer`;
    const outputPath = path.join(temporaryDirectory, "transfer-list");
    await fs.mkdir(path.join(root, "nested"));
    await Promise.all([
      fs.writeFile(path.join(root, "alpha.txt"), "alpha"),
      fs.writeFile(path.join(root, "nested", "beta.txt"), "beta"),
    ]);
    await git(root, "init", "--quiet");
    const shortWriteObserved = injectPositiveShortWrite(outputPath);

    await createWorkspaceGitTransferList({
      gitRoot: root,
      temporaryDirectory,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(shortWriteObserved()).toBe(true);
    await expect(fs.readFile(outputPath)).resolves.toEqual(
      Buffer.from("alpha.txt\0nested/beta.txt\0"),
    );
  });

  it.each(["ignored", "selected"] as const)(
    "settles both Git writers when %s fails first",
    async (firstFailure) => {
      const root = await fs.realpath(tempDirs.make("openclaw-workspace-list-writers-"));
      const workspace = path.join(root, "workspace");
      const temporaryDirectory = path.join(root, "transfer");
      await fs.mkdir(workspace);
      await git(workspace, "init", "--quiet");
      await fs.writeFile(path.join(workspace, ".worktreeinclude"), "selected.txt\n");
      const started = createDeferred();
      const release = { ignored: createDeferred(), selected: createDeferred() };
      const errors = {
        ignored: new Error("ignored inventory writer failed"),
        selected: new Error("selected inventory writer failed"),
      };
      const observed = new Set<string>();
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const target = args[0];
        if (typeof target === "string" && path.dirname(target) === temporaryDirectory) {
          const name = path.basename(target);
          if (name === "ignored" || name === "selected") {
            observed.add(name);
            started.resolve();
            await release[name].promise;
            throw errors[name];
          }
        }
        return await originalOpen(...args);
      });
      const operation = createWorkspaceGitTransferList({
        gitRoot: workspace,
        temporaryDirectory,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });
      const settled = vi.fn();
      void operation.then(settled, settled);
      try {
        await Promise.race([started.promise, operation]);
        expect(observed).toEqual(new Set(["ignored", "selected"]));
        release[firstFailure].resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).not.toHaveBeenCalled();
        release.ignored.resolve();
        release.selected.resolve();
        await expect(operation).rejects.toBe(errors.ignored);
      } finally {
        release.ignored.resolve();
        release.selected.resolve();
        await operation.catch(() => undefined);
      }
    },
  );

  it("fully persists a filtered Git transfer list after a positive short write", async () => {
    const root = tempDirs.make("openclaw-workspace-filter-short-write-");
    const preparedListPath = path.join(root, "prepared");
    const outputPath = path.join(root, "filtered");
    await fs.mkdir(path.join(root, "nested"));
    await Promise.all([
      fs.writeFile(path.join(root, "alpha.txt"), "alpha"),
      fs.writeFile(path.join(root, "nested", "beta.txt"), "beta"),
      fs.writeFile(preparedListPath, "alpha.txt\0missing.txt\0nested/beta.txt\0"),
    ]);
    const shortWriteObserved = injectPositiveShortWrite(outputPath);

    await filterExistingGitTransferList({ gitRoot: root, preparedListPath, outputPath });

    expect(shortWriteObserved()).toBe(true);
    await expect(fs.readFile(outputPath)).resolves.toEqual(
      Buffer.from("alpha.txt\0nested/beta.txt\0"),
    );
  });

  it("force-kills a command that ignores abort termination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-sync-"));
    const outputPath = path.join(root, "output");
    const readyPath = path.join(root, "ready");
    const controller = new AbortController();
    const operation = runWorkspaceInventoryCommandToFile({
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

  it("stops a pack producer before it can exceed its output budget", async () => {
    const root = tempDirs.make("openclaw-workspace-pack-limit-");
    const outputPath = path.join(root, "pack");

    await expect(
      runWorkspaceInventoryCommandToFile({
        argv: [process.execPath, "-e", 'process.stdout.write("x".repeat(1024))'],
        outputPath,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
        maxOutputBytes: 16,
      }),
    ).rejects.toThrow("pack exceeds the 16 byte limit");
    await expect(fs.stat(outputPath)).resolves.toMatchObject({ size: 0 });
  });

  it("omits derived artifacts from outbound Git file lists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-files-"));
    const retainedFiles = [
      "src/keep.ts",
      "openclaw-inbound-project/report.txt",
      "nested/openclaw-inbound-12345678-1234-4234-8234-123456789ab-/report.txt",
    ];
    const files = [
      ...retainedFiles,
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
      "openclaw-inbound-12345678-1234-4234-8234-123456789abc/report.pdf",
      "nested/openclaw-inbound-12345678-1234-4234-8234-123456789abc/photo.png",
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
      await runWorkspaceInventoryCommandToFile({
        argv: ["git", "-C", root, "init", "--quiet"],
        outputPath: initOutputPath,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });

      const outputPath = await createWorkspaceGitTransferList({
        gitRoot: root,
        temporaryDirectory,
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });

      expect((await fs.readFile(outputPath, "utf8")).split("\0").filter(Boolean)).toEqual(
        retainedFiles.toSorted(),
      );
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
    const countFile = path.join(bin, "git-entry-count");
    const firstTransfer = `${root}-transfer-accepted`;
    const secondTransfer = `${root}-transfer-rejected`;
    // Rewriting an executed script between spawns races exec against a forked
    // child still holding the write fd (ETXTBSY). Write the script once and
    // vary only a data file it reads.
    const writeMockGit = async (count: number) => {
      await fs.writeFile(countFile, String(count));
    };
    try {
      await fs.mkdir(bin);
      await fs.writeFile(
        mockGit,
        `#!/usr/bin/env node
const fs = require("node:fs");
const count = Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8"));
process.stdout.write("eligible.txt\\0".repeat(count));
`,
        { mode: 0o755 },
      );
      await fs.writeFile(path.join(root, "eligible.txt"), "eligible\n");
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      await writeMockGit(MAX_WORKSPACE_INVENTORY_ENTRIES + 1);

      const acceptedPath = await createWorkspaceGitTransferList({
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
        createWorkspaceGitTransferList({
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
      const transferPath = await createWorkspaceGitTransferList({
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
