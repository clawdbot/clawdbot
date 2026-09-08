import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { runCommandBuffered, runExec } from "../process/exec.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const transferDebug = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "node-host/worker-workspace"
        ? { ...logger, debug: transferDebug }
        : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(root: string, args: string[]): Promise<string> {
  const result = await runExec("git", ["-C", root, ...args], {
    baseEnv: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
    logOutput: false,
  });
  return result.stdout.trim();
}

describe("node worker Git transfers", () => {
  it.runIf(process.platform === "win32")(
    "reuses foreign executable Git-base files without requesting an unavailable blob",
    async () => {
      const root = tempDirs.make("node-worker-transfer-windows-git-executable-");
      const source = path.join(root, "source");
      const workspaceDir = path.join(root, "workspace");
      const content = Buffer.from("#!/bin/sh\necho tracked\n");
      await fs.mkdir(source);
      await git(source, ["init", "--quiet", "--object-format=sha1"]);
      await git(source, ["config", "core.filemode", "false"]);
      await fs.writeFile(path.join(source, "script.sh"), content);
      const object = await git(source, ["hash-object", "-w", "script.sh"]);
      await git(source, ["update-index", "--add", "--cacheinfo", `100755,${object},script.sh`]);
      await git(source, ["commit", "--quiet", "-m", "POSIX executable base"]);
      const commit = await git(source, ["rev-parse", "HEAD"]);
      const rawManifest = serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit: commit,
        entries: [
          {
            path: "script.sh",
            type: "file",
            mode: 0o755,
            size: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      });
      const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
      const packed = await runCommandBuffered(
        ["git", "-C", source, "pack-objects", "--stdout", "--revs"],
        { input: `${commit}\n`, maxOutputBytes: 4 * 1024 * 1024 },
      );
      expect(packed.code).toBe(0);
      let requestedBlobs = 0;
      const server = createHttpServer((req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200).end(rawManifest);
        } else if (req.url?.endsWith("/pack")) {
          res.writeHead(200).end(packed.stdout);
        } else {
          requestedBlobs += 1;
          res.writeHead(404).end();
        }
      });
      const gatewayUrl = await listen(server);
      try {
        await expect(
          runNodeWorkerWorkspaceTransfer({
            gatewayUrl,
            environmentId: "environment-windows-git-executable",
            workspaceDir,
            manifestHome: root,
            transfer: { direction: "download", token: "download-token", manifestRef },
          }),
        ).resolves.toBe(manifestRef);
        expect(requestedBlobs).toBe(0);
        await expect(fs.readFile(path.join(workspaceDir, "script.sh"))).resolves.toEqual(content);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  const gitTransfers = [
    {
      description: "reuses Git-base tracked files without requesting unavailable blobs",
      changed: false,
      replaceSymlinkAncestor: false,
      lateWrite: false,
    },
    {
      description: "downloads changed and nested files without restoring deleted Git-base paths",
      changed: true,
      replaceSymlinkAncestor: false,
      lateWrite: false,
    },
    {
      description: "replaces a Git-base symlink ancestor without changing files outside staging",
      changed: false,
      replaceSymlinkAncestor: true,
      lateWrite: false,
    },
    {
      description: "preserves the prior workspace when a matched base file changes before capture",
      changed: true,
      replaceSymlinkAncestor: false,
      lateWrite: true,
    },
  ];
  it.each([
    ...gitTransfers.flatMap((scenario) => [
      { ...scenario, seedState: "unused" },
      { ...scenario, seedState: "available" },
    ]),
    ...["absent", "missing-base", "symlink", "oversized"].map((seedState) => ({
      description: "handles a prepared project cache " + seedState,
      changed: false,
      replaceSymlinkAncestor: false,
      lateWrite: false,
      seedState,
    })),
  ])(
    "$description (prepared project: $seedState)",
    async ({ changed, replaceSymlinkAncestor, lateWrite, seedState }) => {
      transferDebug.mockClear();
      const root = tempDirs.make("node-worker-transfer-git-");
      const source = path.join(root, "source");
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(source);
      await git(source, ["init", "--quiet", "--object-format=sha1"]);
      await fs.writeFile(path.join(source, "tracked.txt"), "tracked from gateway\n");
      await fs.writeFile(path.join(source, "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fs.writeFile(path.join(source, "deleted.txt"), "deleted after commit\n");
      await fs.symlink("tracked.txt", path.join(source, "tracked-link"));
      const outsideSentinel = path.join(root, "outside", "file.txt");
      if (replaceSymlinkAncestor) {
        await fs.mkdir(path.dirname(outsideSentinel));
        await fs.writeFile(outsideSentinel, "outside must stay unchanged\n");
        await fs.symlink("../outside", path.join(source, "nested"));
      }
      await git(source, ["add", "."]);
      await git(source, ["commit", "--quiet", "-m", "base"]);
      const commit = await git(source, ["rev-parse", "HEAD"]);
      const seedsRoot = path.join(root, "git-seeds");
      const gatewayNamespace = "gateway";
      const seedKey = "a".repeat(64);
      const seedDir = path.join(seedsRoot, gatewayNamespace, seedKey);
      const invalidSeed = ["missing-base", "symlink", "oversized"].includes(seedState);
      if (seedState !== "unused" && seedState !== "absent") {
        await fs.cp(source, seedDir, { recursive: true, verbatimSymlinks: true });
        await git(seedDir, ["remote", "add", "origin", "https://example.invalid/private.git"]);
        await fs.writeFile(path.join(seedDir, "seed-only.txt"), "never copy the cached worktree\n");
        const objects = path.join(seedDir, ".git", "objects");
        await fs.writeFile(
          path.join(objects, "info", "alternates"),
          path.join(root, "unrelated-objects"),
        );
        if (seedState === "missing-base") {
          await fs.unlink(path.join(objects, commit.slice(0, 2), commit.slice(2)));
        } else if (seedState === "symlink") {
          await fs.rm(objects, { recursive: true });
          await fs.symlink(path.join(source, ".git", "objects"), objects, "dir");
        } else if (seedState === "oversized") {
          const oversized = await fs.open(path.join(objects, "oversized"), "w");
          try {
            await oversized.truncate(MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);
          } finally {
            await oversized.close();
          }
        }
      }
      if (invalidSeed || lateWrite) {
        await fs.mkdir(workspaceDir);
        await fs.writeFile(path.join(workspaceDir, "previous.txt"), "preserve prior workspace\n");
      }
      if (changed) {
        await fs.writeFile(path.join(source, "tracked.txt"), "changed on gateway\n");
        await fs.chmod(path.join(source, "tracked.txt"), 0o755);
        await fs.unlink(path.join(source, "tracked-link"));
        await fs.symlink("script.sh", path.join(source, "tracked-link"));
        await fs.unlink(path.join(source, "deleted.txt"));
        await fs.mkdir(path.join(source, "nested"));
        await fs.writeFile(path.join(source, "nested", "file.txt"), "new nested content\n");
      }
      if (replaceSymlinkAncestor) {
        await fs.unlink(path.join(source, "nested"));
        await fs.mkdir(path.join(source, "nested"));
        await fs.writeFile(path.join(source, "nested", "file.txt"), "safe nested content\n");
      }
      const snapshot = await readActualWorkspaceManifest({ root: source, baseCommit: commit });
      const rawManifest = serializeWorkerWorkspaceManifest(snapshot.manifest);
      const packed = await runCommandBuffered(
        ["git", "-C", source, "pack-objects", "--stdout", "--revs"],
        { input: `${commit}\n`, maxOutputBytes: 4 * 1024 * 1024 },
      );
      expect(packed.termination, packed.stderr.toString("utf8")).toBe("exit");
      expect(packed.code).toBe(0);
      const tracked = snapshot.manifest.entries.find(
        (entry) => entry.type === "file" && entry.path === "tracked.txt",
      );
      if (tracked?.type !== "file") {
        throw new Error("test Git workspace has no tracked file");
      }
      const downloadablePaths = new Set([
        ...(changed ? ["nested/file.txt", "tracked.txt"] : []),
        ...(replaceSymlinkAncestor ? ["nested/file.txt"] : []),
      ]);
      const filesByHash = new Map(
        snapshot.manifest.entries.flatMap((entry) =>
          entry.type === "file" && downloadablePaths.has(entry.path)
            ? [[entry.sha256, path.join(source, entry.path)] as const]
            : [],
        ),
      );
      const requestedBlobs: string[] = [];
      let requestedPacks = 0;
      const server = createHttpServer((req, res) => {
        void (async () => {
          if (req.url?.endsWith("/manifest")) {
            res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
            res.end(rawManifest);
            return;
          }
          if (req.url?.endsWith("/pack")) {
            requestedPacks += 1;
            res.writeHead(200, { "content-length": String(packed.stdout.byteLength) });
            res.end(packed.stdout);
            return;
          }
          const sha256 = req.url?.match(/\/blobs\/([a-f0-9]{64})$/u)?.[1];
          if (sha256) {
            requestedBlobs.push(sha256);
            const file = filesByHash.get(sha256);
            if (file) {
              if (lateWrite && sha256 === tracked.sha256) {
                const staging = (await fs.readdir(root)).find((name) =>
                  name.startsWith(".workspace.workspace-transfer-"),
                );
                expect(staging).toBeDefined();
                const script = path.join(root, staging!, "script.sh");
                const original = await fs.stat(script);
                await fs.writeFile(script, "#!/bin/sh\nexit 1\n");
                await fs.utimes(script, original.atime, original.mtime);
              }
              const body = await fs.readFile(file);
              res.writeHead(200, { "content-length": String(body.byteLength) });
              res.end(body);
              return;
            }
          }
          res.writeHead(404).end();
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      const gatewayUrl = await listen(server);
      try {
        const transfer = runNodeWorkerWorkspaceTransfer({
          seedsRoot,
          gatewayNamespace,
          gatewayUrl,
          environmentId: "environment-git",
          workspaceDir,
          manifestHome: root,
          hashMemo: new Map(),
          transfer: {
            direction: "download",
            token: "test-token",
            manifestRef: snapshot.manifestRef,
            ...(seedState === "unused" ? {} : { seedKey }),
          },
        });
        if (invalidSeed) {
          await expect(transfer).rejects.toThrow("prepared project seed is invalid");
          expect(requestedPacks).toBe(0);
          expect(await fs.readFile(path.join(workspaceDir, "previous.txt"), "utf8")).toBe(
            "preserve prior workspace\n",
          );
          return;
        }
        if (lateWrite) {
          await expect(transfer).rejects.toMatchObject({
            cause: expect.objectContaining({
              message: expect.stringContaining("materialized a different manifest"),
            }),
          });
          expect(await fs.readFile(path.join(workspaceDir, "previous.txt"), "utf8")).toBe(
            "preserve prior workspace\n",
          );
          return;
        }
        await expect(transfer).resolves.toBe(snapshot.manifestRef);
        expect(requestedPacks).toBe(seedState === "available" ? 0 : 1);
        await expect(fs.access(path.join(workspaceDir, "seed-only.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.access(path.join(workspaceDir, ".git", "objects", "info", "alternates")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(workspaceDir, ".git", "config"), "utf8")).not.toContain(
          "example.invalid/private.git",
        );
        await expect(fs.readFile(path.join(workspaceDir, "tracked.txt"), "utf8")).resolves.toBe(
          changed ? "changed on gateway\n" : "tracked from gateway\n",
        );
        if (process.platform !== "win32") {
          // Git checkout applies the umask; downloaded replacements are explicitly chmod'ed.
          const checkoutUmask = process.umask();
          expect((await fs.stat(path.join(workspaceDir, "tracked.txt"))).mode & 0o777).toBe(
            changed ? 0o755 : 0o666 & ~checkoutUmask,
          );
          expect((await fs.stat(path.join(workspaceDir, "script.sh"))).mode & 0o777).toBe(
            0o777 & ~checkoutUmask,
          );
        }
        await expect(fs.readlink(path.join(workspaceDir, "tracked-link"))).resolves.toBe(
          changed ? "script.sh" : "tracked.txt",
        );
        expect(requestedBlobs).toEqual([...filesByHash.keys()]);
        expect(transferDebug).toHaveBeenCalledWith(
          "node worker manifest capture completed",
          expect.objectContaining({
            contentHashCount: downloadablePaths.size,
            memoHitCount:
              snapshot.manifest.entries.filter((entry) => entry.type === "file").length -
              downloadablePaths.size,
          }),
        );
        await expect(git(workspaceDir, ["rev-parse", "HEAD"])).resolves.toBe(commit);
        if (changed) {
          await expect(fs.access(path.join(workspaceDir, "deleted.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        if (changed || replaceSymlinkAncestor) {
          expect((await fs.lstat(path.join(workspaceDir, "nested"))).isDirectory()).toBe(true);
          await expect(
            fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8"),
          ).resolves.toBe(changed ? "new nested content\n" : "safe nested content\n");
        }
        if (!changed && !replaceSymlinkAncestor) {
          await expect(git(workspaceDir, ["status", "--porcelain=v1"])).resolves.toBe("");
        }
        expect(transferDebug).toHaveBeenCalledWith(
          "node worker workspace transfer completed",
          expect.objectContaining({
            environmentId: "environment-git",
            direction: "download",
            outcome: "succeeded",
            durationMs: expect.any(Number),
            baseSource: seedState === "available" ? "prepared-project-seed" : "gateway-pack",
            ...(seedState === "available" ? {} : { packDownloadMs: expect.any(Number) }),
            blobApplyMs: expect.any(Number),
          }),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        if (replaceSymlinkAncestor) {
          await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe(
            "outside must stay unchanged\n",
          );
        }
      }
    },
  );
});
