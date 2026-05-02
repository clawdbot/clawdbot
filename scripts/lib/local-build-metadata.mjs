import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE } from "./local-build-metadata-paths.mjs";

export { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE };

export function resolveGitHead(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  try {
    const result = spawnSyncImpl("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

export function writeBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(buildStampPath, `${JSON.stringify({ builtAt: now(), head })}\n`, "utf8");
  return buildStampPath;
}

export function writeRuntimePostBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const distRoot = path.join(cwd, "dist");
  const stampPath = path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE);
  const head = resolveGitHead({
    cwd,
    spawnSync: params.spawnSync,
  });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(
    stampPath,
    `${JSON.stringify(
      {
        syncedAt: now(),
        ...(head ? { head } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return stampPath;
}
