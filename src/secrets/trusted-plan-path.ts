import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { trustedPlanPathPolicy } from "./trusted-plan-path-policy.js";

const { isSafeWindowsDirectoryAclSummary, isTrustedOwner } = trustedPlanPathPolicy;

async function readShebangInterpreter(targetPath: string): Promise<string | undefined> {
  const handle = await fs.open(targetPath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) {
      return undefined;
    }
    const newline = buffer.indexOf(0x0a, 2);
    if (newline < 0) {
      throw new Error(`script interpreter line is too long: ${targetPath}`);
    }
    const line = buffer.subarray(2, newline).toString("utf8").trim();
    const interpreter = line.split(/\s+/u, 1)[0];
    if (!interpreter || !path.isAbsolute(interpreter)) {
      throw new Error(`script interpreter must be an absolute path: ${targetPath}`);
    }
    return interpreter;
  } finally {
    await handle.close();
  }
}

async function assertTrustedPathChain(
  resolvedPath: string,
  targetType: "directory" | "file",
  options: { allowWindowsTargetTrustedInstaller?: boolean } = {},
): Promise<void> {
  const validatedEntries: Array<{ path: string; dev: number | bigint; ino: number | bigint }> = [];
  let currentPath = resolvedPath;
  let first = true;
  for (;;) {
    const before = await fs.lstat(currentPath);
    const [stat, permissions] = await Promise.all([
      safeStat(currentPath),
      inspectPathPermissions(currentPath),
    ]);
    const after = await fs.lstat(currentPath);
    if (!stat.ok || !permissions.ok || permissions.source === "unknown") {
      throw new Error(`permissions could not be verified: ${currentPath}`);
    }
    if (
      before.isSymbolicLink() ||
      after.isSymbolicLink() ||
      stat.isSymlink ||
      permissions.isSymlink ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error(`path changed during permission verification: ${currentPath}`);
    }
    const expectedDirectory = !first || targetType === "directory";
    if (stat.isDir !== expectedDirectory) {
      throw new Error(`unexpected path type: ${currentPath}`);
    }
    // TrustedInstaller legitimately owns Windows system paths. Targets remain strict unless a
    // caller validates a pinned system executable through the dedicated resolver below.
    const allowWindowsTrustedInstaller =
      !first || (first && options.allowWindowsTargetTrustedInstaller === true);
    if (!isTrustedOwner(stat, permissions, process.platform, allowWindowsTrustedInstaller)) {
      throw new Error(`path is not owned by the current user or root: ${currentPath}`);
    }
    const stickyDirectory =
      stat.isDir && permissions.mode != null && (permissions.mode & 0o1000) !== 0;
    if ((permissions.groupWritable || permissions.worldWritable) && !stickyDirectory) {
      const safeWindowsDirectory =
        process.platform === "win32" &&
        stat.isDir &&
        isSafeWindowsDirectoryAclSummary(
          permissions.aclSummary,
          targetType === "directory" || currentPath !== path.dirname(resolvedPath),
        );
      // Windows directories commonly allow adding new children or carry inherit-only full
      // control for each child's eventual owner. Executable parents reject child creation.
      if (!safeWindowsDirectory) {
        throw new Error(`path is writable by another user: ${currentPath}`);
      }
    }
    validatedEntries.push({ path: currentPath, dev: after.dev, ino: after.ino });

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
    first = false;
  }
  // Recheck from the trusted root toward the target after the full chain is known.
  for (const entry of validatedEntries.toReversed()) {
    const current = await fs.lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) {
      throw new Error(`path changed after permission verification: ${entry.path}`);
    }
  }
}

async function assertTrustedPath(
  targetPath: string,
  validatedScripts = new Set<string>(),
  options: { allowWindowsTargetTrustedInstaller?: boolean } = {},
): Promise<string> {
  const resolvedPath = await fs.realpath(targetPath);
  const targetStat = await fs.stat(resolvedPath);
  if (!targetStat.isFile()) {
    throw new Error(`path is not a regular file: ${resolvedPath}`);
  }
  await fs.access(resolvedPath, fsSync.constants.X_OK);
  await assertTrustedPathChain(resolvedPath, "file", options);
  if (process.platform === "win32" && path.extname(resolvedPath).toLowerCase() !== ".exe") {
    throw new Error(`Windows executable must be an .exe file: ${resolvedPath}`);
  }
  const interpreter = await readShebangInterpreter(resolvedPath);
  if (interpreter) {
    if (validatedScripts.has(resolvedPath)) {
      throw new Error(`script interpreter cycle detected: ${resolvedPath}`);
    }
    validatedScripts.add(resolvedPath);
    if (path.basename(interpreter).toLowerCase() === "env") {
      throw new Error(`script interpreter may not use env indirection: ${resolvedPath}`);
    }
    const resolvedInterpreter = await assertTrustedPath(interpreter, validatedScripts);
    // The kernel launches the literal shebang path, so aliases cannot use an unverified link.
    if (resolvedInterpreter !== interpreter) {
      throw new Error(`script interpreter path must be canonical: ${interpreter}`);
    }
  }
  return resolvedPath;
}

export async function resolveTrustedExecutablePath(targetPath: string): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Executable path must be absolute: ${targetPath}`);
  }
  return await assertTrustedPath(targetPath);
}

export async function resolveTrustedWindowsSystemExecutablePath(
  targetPath: string,
): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Executable path must be absolute: ${targetPath}`);
  }
  return await assertTrustedPath(targetPath, new Set(), {
    allowWindowsTargetTrustedInstaller: true,
  });
}

export async function resolveTrustedPlanDirectoryPath(targetPath: string): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Directory path must be absolute: ${targetPath}`);
  }
  const resolvedPath = await fs.realpath(targetPath);
  await assertTrustedPathChain(resolvedPath, "directory");
  return resolvedPath;
}
