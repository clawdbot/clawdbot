import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
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

export type WorkerBundleSourceIdentityEntry = {
  path: string;
  realPath: string;
  kind: "directory" | "file";
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function sourceIdentityStats(stats: BigIntStats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

async function stageWorkerDeployArtifact(params: {
  sourceRoot: string;
  stagingRoot: string;
  artifactPath: (typeof WORKER_DEPLOY_ARTIFACT_PATHS)[number];
}): Promise<{
  entry: WorkerBundleManifestEntry;
  sourceIdentity: WorkerBundleSourceIdentityEntry;
}> {
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
  let openedStats: BigIntStats;
  try {
    openedStats = await handle.stat({ bigint: true });
    const currentStats = await fs.lstat(sourcePath, { bigint: true });
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
  await fs.writeFile(stagedPath, contents, { mode: 0o700 });
  await fs.chmod(stagedPath, 0o700);
  return {
    entry: {
      path: params.artifactPath,
      mode: 0o700,
      size: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
    sourceIdentity: {
      path: expectedRealPath,
      realPath: expectedRealPath,
      kind: "file",
      ...sourceIdentityStats(openedStats),
    },
  };
}

async function stageWorkerDeployArtifacts(sourceRoot: string, stagingRoot: string) {
  const staged = [];
  for (const artifactPath of WORKER_DEPLOY_ARTIFACT_PATHS) {
    staged.push(await stageWorkerDeployArtifact({ sourceRoot, stagingRoot, artifactPath }));
  }
  return staged;
}

export async function collectWorkerBundleManifest(
  sourceRoot: string,
  stagingRoot: string,
): Promise<WorkerBundleManifestEntry[]> {
  const staged = await stageWorkerDeployArtifacts(sourceRoot, stagingRoot);
  return staged.map((artifact) => artifact.entry);
}

export async function collectWorkerBundleManifestWithSourceIdentity(
  sourceRoot: string,
  stagingRoot: string,
): Promise<{
  manifest: WorkerBundleManifestEntry[];
  sourceIdentity: WorkerBundleSourceIdentityEntry[];
}> {
  const staged = await stageWorkerDeployArtifacts(sourceRoot, stagingRoot);
  return {
    manifest: staged.map((artifact) => artifact.entry),
    sourceIdentity: staged.map((artifact) => artifact.sourceIdentity),
  };
}
