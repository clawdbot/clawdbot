// Local directory upload into a Daytona sandbox via a tar file over the toolbox API.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { Sandbox } from "./client.js";

/**
 * Reject symlinks that escape the uploaded tree so extracting the tar inside
 * the sandbox cannot recreate links pointing at host-private paths.
 */
async function assertSafeDaytonaUploadSymlinks(localDir: string): Promise<void> {
  const rootDir = path.resolve(localDir);
  const resolvedRoot = await fs.realpath(rootDir);
  await walkDirectory(rootDir);

  async function walkDirectory(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        const relativePath = path.relative(rootDir, entryPath).split(path.sep).join("/");
        let resolvedTarget: string;
        try {
          resolvedTarget = await fs.realpath(entryPath);
        } catch {
          throw new Error(
            `Daytona sandbox upload refuses broken symlink in the workspace: ${relativePath}`,
          );
        }
        if (resolvedTarget !== resolvedRoot && !isPathInside(resolvedRoot, resolvedTarget)) {
          throw new Error(
            `Daytona sandbox upload refuses symlink escaping the workspace: ${relativePath}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walkDirectory(entryPath);
      }
    }
  }
}

function createLocalTarFile(localDir: string, tarPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-C", localDir, "-cf", tarPath, "."], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    tar.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderr).toString("utf8").trim() || `tar exited with code ${code ?? 1}`,
        ),
      );
    });
  });
}

/**
 * Upload a local directory into the sandbox by shipping one tar file through
 * the toolbox files API and extracting it remotely. Tar keeps permissions,
 * executable bits, and empty directories that per-file uploads would lose.
 */
export async function uploadDirectoryToDaytonaSandbox(params: {
  sandbox: Sandbox;
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
  runRemoteShellScript: (params: {
    script: string;
    args?: string[];
  }) => Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;
  /** Wraps direct toolbox calls so auto-stopped sandboxes restart first. */
  runRemoteOperation?: <T>(run: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  await assertSafeDaytonaUploadSymlinks(params.localDir);
  await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-daytona-upload-" },
    async (workspace) => {
      const tarPath = workspace.path("openclaw-seed.tar");
      await createLocalTarFile(params.localDir, tarPath);
      const remoteTarPath = `/tmp/openclaw-seed-${randomBytes(12).toString("hex")}.tar`;
      const runRemoteOperation = params.runRemoteOperation ?? (async (run) => await run());
      await runRemoteOperation(() =>
        params.sandbox.fs.uploadFile(tarPath, remoteTarPath, Math.ceil(params.timeoutMs / 1000)),
      );
      try {
        await params.runRemoteShellScript({
          // Extraction failures must still remove the staged tar, and the
          // original extract exit code has to survive the cleanup.
          script: 'mkdir -p -- "$1" && tar -xf "$2" -C "$1"; ec=$?; rm -f -- "$2"; exit $ec',
          args: [params.remoteDir, remoteTarPath],
        });
      } catch (error) {
        // The sandbox persists per scope; a transport failure must not leave
        // the staged workspace tar behind. The extract script removes it on
        // the normal path, so a missing file here is fine.
        await params.sandbox.fs.deleteFile(remoteTarPath).catch(() => {});
        throw error;
      }
    },
  );
}
