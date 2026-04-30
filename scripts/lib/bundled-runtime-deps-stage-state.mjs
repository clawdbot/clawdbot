import fs from "node:fs";
import path from "node:path";

const TRANSIENT_TEMP_REMOVE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
const TEMP_REMOVE_RETRY_DELAYS_MS = [10, 25, 50];
const TEMP_OWNER_FILE = "owner.json";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function removePathIfExists(targetPath, options = {}) {
  const retryDelays = options.retryTransient ? TEMP_REMOVE_RETRY_DELAYS_MS : [];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!isTransientTempRemoveError(error)) {
        throw error;
      }
      const delay = retryDelays[attempt];
      if (delay === undefined) {
        if (options.ignoreTransient) {
          return false;
        }
        throw error;
      }
      sleepSync(delay);
    }
  }
  return true;
}

export function removeOwnedTempPathBestEffort(targetPath) {
  return removePathIfExists(targetPath, { retryTransient: true, ignoreTransient: true });
}

function isTransientTempRemoveError(error) {
  return (
    !!error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    TRANSIENT_TEMP_REMOVE_ERROR_CODES.has(error.code)
  );
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

export function writeRuntimeDepsTempOwner(tempDir) {
  writeJson(path.join(tempDir, TEMP_OWNER_FILE), {
    pid: process.pid,
    createdAtMs: Date.now(),
  });
}

function makeOwnedTempDir(parentDir, prefix) {
  const tempDir = makeTempDir(parentDir, prefix);
  writeRuntimeDepsTempOwner(tempDir);
  return tempDir;
}

export function sanitizeTempPrefixSegment(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "plugin";
}

export function makePluginOwnedTempDir(pluginDir, label) {
  return makeOwnedTempDir(pluginDir, `.openclaw-runtime-deps-${label}-`);
}

export function assertPathIsNotSymlink(targetPath, label) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`refusing to ${label} via symlinked path: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function replaceDirAtomically(targetPath, sourcePath) {
  assertPathIsNotSymlink(targetPath, "replace runtime deps");
  const targetParentDir = path.dirname(targetPath);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const backupPath = makeTempDir(
    targetParentDir,
    `.openclaw-runtime-deps-backup-${sanitizeTempPrefixSegment(path.basename(targetPath))}-`,
  );
  removePathIfExists(backupPath, { retryTransient: true });

  let movedExistingTarget = false;
  try {
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      writeRuntimeDepsTempOwner(backupPath);
      movedExistingTarget = true;
    }
    fs.renameSync(sourcePath, targetPath);
    removeOwnedTempPathBestEffort(backupPath);
  } catch (error) {
    if (movedExistingTarget && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
      removePathIfExists(path.join(targetPath, TEMP_OWNER_FILE));
    }
    throw error;
  }
}

export function writeJsonAtomically(targetPath, value) {
  assertPathIsNotSymlink(targetPath, "write runtime deps stamp");
  const targetParentDir = path.dirname(targetPath);
  fs.mkdirSync(targetParentDir, { recursive: true });
  const tempDir = makeOwnedTempDir(
    targetParentDir,
    `.openclaw-runtime-deps-stamp-${sanitizeTempPrefixSegment(path.basename(targetPath))}-`,
  );
  const tempPath = path.join(tempDir, path.basename(targetPath));
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(tempPath, targetPath);
  } finally {
    removeOwnedTempPathBestEffort(tempDir);
  }
}

function readRuntimeDepsTempOwner(tempDir) {
  try {
    const owner = readJson(path.join(tempDir, TEMP_OWNER_FILE));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function isLiveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function shouldRemoveRuntimeDepsTempDir(tempDir) {
  const owner = readRuntimeDepsTempOwner(tempDir);
  if (!owner || typeof owner.pid !== "number") {
    return true;
  }
  return !isLiveProcess(owner.pid);
}

export function removeStaleRuntimeDepsTempDirs(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return;
  }
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".openclaw-runtime-deps-")) {
      const targetPath = path.join(pluginDir, entry.name);
      if (!shouldRemoveRuntimeDepsTempDir(targetPath)) {
        continue;
      }
      removeOwnedTempPathBestEffort(targetPath);
    }
  }
}
