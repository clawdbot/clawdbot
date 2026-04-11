import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

export function mkdirSafeDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

export function makeTrackedTempDir(prefix: string, trackedDirs: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
  chmodSafeDir(dir);
  trackedDirs.push(dir);
  return dir;
}

export async function makeTrackedTempDirAsync(prefix: string, trackedDirs: string[]) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix + "-"));
  chmodSafeDir(dir);
  trackedDirs.push(dir);
  return dir;
}

export function cleanupTrackedTempDirs(trackedDirs: string[]) {
  for (const dir of trackedDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

export async function cleanupTrackedTempDirsAsync(trackedDirs: string[]) {
  await Promise.all(
    trackedDirs.splice(0).map(async (dir) => {
      try {
        await fsPromises.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }),
  );
}

export function createSuiteTempRootTracker(
  prefix: string,
  baseDir = path.join(process.cwd(), ".tmp"),
) {
  let suiteTempRoot = "";
  let tempDirCounter = 0;

  function ensureSuiteTempRoot() {
    if (suiteTempRoot) {
      return suiteTempRoot;
    }
    fs.mkdirSync(baseDir, { recursive: true });
    suiteTempRoot = fs.mkdtempSync(path.join(baseDir, `${prefix}-`));
    return suiteTempRoot;
  }

  function makeTempDir() {
    const dir = path.join(ensureSuiteTempRoot(), `case-${tempDirCounter}`);
    tempDirCounter += 1;
    fs.mkdirSync(dir);
    return dir;
  }

  function cleanup() {
    if (!suiteTempRoot) {
      return;
    }
    try {
      fs.rmSync(suiteTempRoot, { recursive: true, force: true });
    } finally {
      suiteTempRoot = "";
      tempDirCounter = 0;
    }
  }

  return {
    cleanup,
    ensureSuiteTempRoot,
    makeTempDir,
  };
}
