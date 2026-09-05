import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";

async function removeTransferArtifact(target: string): Promise<void> {
  await fsp.rm(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  });
}

export async function recoverWorkspaceReplacement(workspaceDir: string): Promise<void> {
  const parent = path.dirname(workspaceDir);
  const workspaceName = path.basename(workspaceDir);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(parent, { withFileTypes: true });
  const stagingPrefix = `.${workspaceName}.workspace-transfer-`;
  const staging = entries.filter((entry) => entry.name.startsWith(stagingPrefix));
  const backups = entries.filter((entry) => entry.name.startsWith(`${workspaceName}.previous-`));
  for (const entry of staging) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeTransferArtifact(path.join(parent, entry.name));
    }
  }
  const workspaceExists = await fsp
    .lstat(workspaceDir)
    .then((stats) => {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("workspace transfer target is not an owned directory");
      }
      return true;
    })
    .catch((error: unknown) => {
      if (extractErrorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    });
  const validBackups: string[] = [];
  for (const entry of backups) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      validBackups.push(path.join(parent, entry.name));
    }
  }
  if (!workspaceExists) {
    if (validBackups.length > 1) {
      throw new Error("workspace transfer recovery found multiple prior workspaces");
    }
    if (validBackups.length === 1) {
      await fsp.rename(validBackups[0]!, workspaceDir);
    }
    return;
  }
  await Promise.all(
    validBackups.map((backup) => removeTransferArtifact(backup).catch(() => undefined)),
  );
}

export async function replaceWorkspace(workspaceDir: string, staging: string): Promise<void> {
  const backup = `${workspaceDir}.previous-${process.pid}-${randomUUID()}`;
  let movedOld = false;
  try {
    await fsp.rename(workspaceDir, backup);
    movedOld = true;
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fsp.rename(staging, workspaceDir);
  } catch (error) {
    if (movedOld) {
      try {
        await fsp.rename(backup, workspaceDir);
      } catch (rollbackError) {
        const recoveryError = new Error(`workspace transfer rollback failed; recover ${backup}`, {
          cause: error,
        });
        Object.defineProperty(recoveryError, "rollbackError", {
          value: rollbackError,
        });
        throw recoveryError;
      }
    }
    throw error;
  }
  if (movedOld) {
    // The second rename is the commit point. Cleanup failure is recovered on the next transfer.
    await removeTransferArtifact(backup).catch(() => undefined);
  }
}
