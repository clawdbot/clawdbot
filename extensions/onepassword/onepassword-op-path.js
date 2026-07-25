import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPathPermissions, safeStat } from "@openclaw/fs-safe/permissions";

const WINDOWS_TRUSTED_INSTALLER_SID =
  "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const WINDOWS_SAFE_DIRECTORY_ACL_TOKENS = new Set([
  "AD",
  "CI",
  "GE",
  "GR",
  "I",
  "IO",
  "NP",
  "OI",
  "R",
  "RA",
  "RC",
  "RD",
  "REA",
  "RX",
  "S",
  "WD",
  "X",
]);
const WINDOWS_SAFE_EXECUTABLE_PARENT_ACL_TOKENS = new Set(
  [...WINDOWS_SAFE_DIRECTORY_ACL_TOKENS].filter((token) => token !== "AD" && token !== "WD"),
);

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isTrustedOwner(
  stat,
  permissions,
  platform = process.platform,
  allowWindowsTrustedInstaller = false,
) {
  if (platform === "win32") {
    return (
      permissions.ownerTrusted === true ||
      (allowWindowsTrustedInstaller &&
        permissions.ownerSid?.toLowerCase() === WINDOWS_TRUSTED_INSTALLER_SID)
    );
  }
  if (typeof process.getuid !== "function" || stat.uid == null) {
    return false;
  }
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

function isSafeWindowsDirectoryAclEntry(entry, allowChildCreation = true) {
  if (!entry || typeof entry.rawRights !== "string") {
    return false;
  }
  const tokens = [...entry.rawRights.matchAll(/\(([^)]+)\)/gu)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean),
  );
  // Inherit-only entries do not grant rights on the directory itself. Descendants are
  // still inspected independently with their effective ACL and owner.
  const safeTokens = allowChildCreation
    ? WINDOWS_SAFE_DIRECTORY_ACL_TOKENS
    : WINDOWS_SAFE_EXECUTABLE_PARENT_ACL_TOKENS;
  return (
    tokens.includes("IO") || (tokens.length > 0 && tokens.every((token) => safeTokens.has(token)))
  );
}

function isSafeWindowsDirectoryAclEntries(entries, allowChildCreation = true) {
  return entries.every((entry) => isSafeWindowsDirectoryAclEntry(entry, allowChildCreation));
}

function isSafeWindowsDirectoryAclSummary(summary, allowChildCreation = true) {
  if (summary === "trusted-only") {
    return true;
  }
  if (typeof summary !== "string" || summary.length === 0) {
    return false;
  }
  const entries = summary.split(", ").map((value) => {
    const separatorIndex = value.lastIndexOf(":");
    const rawRights = separatorIndex > 0 ? value.slice(separatorIndex + 1) : "";
    return /^(?:\([^)]+\))+$/u.test(rawRights) ? { rawRights } : null;
  });
  return (
    entries.length > 0 &&
    entries.every((entry) => entry !== null) &&
    isSafeWindowsDirectoryAclEntries(entries, allowChildCreation)
  );
}

export const testing = {
  isSafeWindowsDirectoryAclEntries,
  isSafeWindowsDirectoryAclSummary,
  isTrustedOwner,
};

async function readShebangInterpreter(targetPath) {
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

async function assertTrustedPath(targetPath, validatedScripts = new Set()) {
  const resolvedPath = await fs.realpath(targetPath);
  const targetStat = await fs.stat(resolvedPath);
  if (!targetStat.isFile()) {
    throw new Error(`path is not a regular file: ${resolvedPath}`);
  }
  await fs.access(resolvedPath, fsSync.constants.X_OK);

  // The CLI receives the service-account token. Validate its resolved parent chain so another
  // local account cannot replace the executable between discovery and a later secret read.
  const validatedEntries = [];
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
    if ((first && stat.isDir) || (!first && !stat.isDir)) {
      throw new Error(`unexpected path type: ${currentPath}`);
    }
    // TrustedInstaller legitimately owns Windows system directories. The requested executable
    // itself still needs fs-safe's local-owner verdict.
    const allowWindowsTrustedInstaller = !first;
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
          currentPath !== path.dirname(resolvedPath),
        );
      // Windows directories commonly allow adding new children or carry inherit-only full
      // control for each child's eventual owner. Higher ancestors cannot replace the checked
      // next component; the executable parent is stricter to prevent side-loaded siblings.
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
  // Recheck from the trusted root toward the executable. The canonical path contains no links,
  // and each verified directory prevents another account replacing the next component.
  for (const entry of validatedEntries.toReversed()) {
    const current = await fs.lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) {
      throw new Error(`path changed after permission verification: ${entry.path}`);
    }
  }
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
    // The kernel launches the literal shebang path, so aliases cannot rely on an unverified link.
    if (resolvedInterpreter !== interpreter) {
      throw new Error(`script interpreter path must be canonical: ${interpreter}`);
    }
  }
  return resolvedPath;
}

export async function resolveTrustedExecutablePath(targetPath) {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Executable path must be absolute: ${targetPath}`);
  }
  return await assertTrustedPath(targetPath);
}

export async function resolveTrustedOnePasswordCli(options = {}) {
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error(`1Password CLI path must be absolute: ${configuredPath}`);
  }
  const executable = process.platform === "win32" ? "op.exe" : "op";
  const candidates = configuredPath
    ? [configuredPath]
    : (options.pathEnv ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, executable));
  let unsafeError;
  for (const candidate of candidates) {
    try {
      return await resolveTrustedExecutablePath(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        continue;
      }
      unsafeError = new Error(
        `Refusing unsafe 1Password CLI path "${candidate}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (configuredPath) {
        throw unsafeError;
      }
    }
  }
  if (unsafeError) {
    throw unsafeError;
  }
  return undefined;
}
