import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  WORKER_BUNDLE_ARTIFACT_MODE,
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
} from "../../shared/worker-bundle-hash.js";

const WORKER_DEPLOY_ARTIFACT_PATHS = [
  WORKER_BUNDLE_ENTRY_PATH,
  WORKER_BUNDLE_RSYNC_RECEIVER_PATH,
] as const;

export type WorkerBundleManifestEntry = {
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

async function stageWorkerDeployArtifact(params: {
  sourceRoot: string;
  stagingRoot: string;
  artifactPath: (typeof WORKER_DEPLOY_ARTIFACT_PATHS)[number];
}): Promise<WorkerBundleManifestEntry> {
  const relativeSourcePath = `dist/worker/${params.artifactPath}`;
  const sourcePath = path.join(params.sourceRoot, relativeSourcePath);
  let expectedRealPath: string;
  try {
    expectedRealPath = await fs.realpath(sourcePath);
  } catch (error) {
    throw new Error(
      `OpenClaw worker deploy artifact is missing; build the running package at ${params.sourceRoot}`,
      { cause: error },
    );
  }
  const expectedPath = path.resolve(params.sourceRoot, relativeSourcePath);
  if (expectedRealPath !== expectedPath) {
    throw new Error(`Unsafe worker deploy artifact: ${relativeSourcePath}`);
  }
  const initialStats = await fs.lstat(sourcePath);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw new Error(`Unsafe worker deploy artifact: ${relativeSourcePath}`);
  }
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: Buffer;
  try {
    const openedStats = await handle.stat();
    const currentStats = await fs.lstat(sourcePath);
    const currentRealPath = await fs.realpath(sourcePath);
    if (
      !openedStats.isFile() ||
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentRealPath !== expectedRealPath ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino
    ) {
      throw new Error(`Worker deploy artifact changed while packaging: ${relativeSourcePath}`);
    }
    contents = await handle.readFile();
  } finally {
    await handle.close();
  }
  const stagedPath = path.join(params.stagingRoot, params.artifactPath);
  await fs.writeFile(stagedPath, contents, { mode: WORKER_BUNDLE_ARTIFACT_MODE });
  await fs.chmod(stagedPath, WORKER_BUNDLE_ARTIFACT_MODE);
  return {
    path: params.artifactPath,
    mode: WORKER_BUNDLE_ARTIFACT_MODE,
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

export async function collectWorkerBundleManifest(
  sourceRoot: string,
  stagingRoot: string,
): Promise<WorkerBundleManifestEntry[]> {
  const manifest: WorkerBundleManifestEntry[] = [];
  for (const artifactPath of WORKER_DEPLOY_ARTIFACT_PATHS) {
    manifest.push(await stageWorkerDeployArtifact({ sourceRoot, stagingRoot, artifactPath }));
  }
  return manifest;
}
