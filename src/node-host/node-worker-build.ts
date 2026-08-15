import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  collectWorkerBundleManifestWithSourceIdentity,
  type WorkerBundleSourceIdentityEntry,
} from "../gateway/worker-environments/bundle-staging.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import { VERSION } from "../version.js";

type NodeWorkerBuildOptions = {
  packageRoot?: string;
  openclawVersion?: string;
  protocolFeatures?: readonly string[];
};

export type NodeWorkerInstallation = {
  packageRoot: string;
  build: WorkerAdmissionHandshake;
  revalidateBuild(): Promise<boolean>;
};

const SOURCE_IDENTITY_STAT_CONCURRENCY = 64;

function sameSourceIdentityStats(
  expected: WorkerBundleSourceIdentityEntry,
  current: BigIntStats,
): boolean {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.mode === expected.mode &&
    current.size === expected.size &&
    current.mtimeNs === expected.mtimeNs &&
    current.ctimeNs === expected.ctimeNs &&
    (expected.kind === "file" ? current.isFile() : current.isDirectory()) &&
    !current.isSymbolicLink()
  );
}

async function matchesWorkerBundleSourceIdentity(
  entries: readonly WorkerBundleSourceIdentityEntry[],
): Promise<boolean> {
  for (let offset = 0; offset < entries.length; offset += SOURCE_IDENTITY_STAT_CONCURRENCY) {
    const batch = entries.slice(offset, offset + SOURCE_IDENTITY_STAT_CONCURRENCY);
    const matches = await Promise.all(
      batch.map(async (expected) => {
        try {
          const current = await fs.lstat(expected.path, { bigint: true });
          return expected.path === expected.realPath && sameSourceIdentityStats(expected, current);
        } catch {
          return false;
        }
      }),
    );
    if (matches.includes(false)) {
      return false;
    }
  }
  return true;
}

async function computeNodeWorkerBuild(
  packageRoot: string,
  options: NodeWorkerBuildOptions,
): Promise<{
  build: WorkerAdmissionHandshake;
  sourceIdentity: WorkerBundleSourceIdentityEntry[];
}> {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-worker-build-"));
  try {
    const collected = await collectWorkerBundleManifestWithSourceIdentity(packageRoot, stagingRoot);
    return {
      build: {
        bundleHash: hashWorkerBundleManifest(collected.manifest),
        openclawVersion: options.openclawVersion ?? VERSION,
        protocolFeatures: [...(options.protocolFeatures ?? WORKER_PROTOCOL_FEATURES)].toSorted(),
      },
      sourceIdentity: collected.sourceIdentity,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Resolves and freezes the package root that produced the node's advertised worker build. */
export async function resolveNodeWorkerInstallation(
  options: NodeWorkerBuildOptions = {},
): Promise<NodeWorkerInstallation> {
  const packageRoot =
    options.packageRoot ??
    resolveOpenClawPackageRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  if (!packageRoot) {
    throw new Error("Unable to locate the running OpenClaw package root for node worker hosting");
  }
  const canonicalRoot = await fs.realpath(packageRoot);
  const initial = await computeNodeWorkerBuild(canonicalRoot, options);
  let sourceIdentity = initial.sourceIdentity;
  let invalid = false;
  let pending: Promise<boolean> | undefined;
  const revalidateBuild = () => {
    if (invalid) {
      return Promise.resolve(false);
    }
    pending ??= (async () => {
      if (await matchesWorkerBundleSourceIdentity(sourceIdentity)) {
        return true;
      }
      try {
        const current = await computeNodeWorkerBuild(canonicalRoot, options);
        if (current.build.bundleHash !== initial.build.bundleHash) {
          invalid = true;
          return false;
        }
        sourceIdentity = current.sourceIdentity;
        return true;
      } catch {
        invalid = true;
        return false;
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    packageRoot: canonicalRoot,
    build: initial.build,
    // The prepared runtime owns one immutable advertised build. Launches stat this
    // fixed source set and only rebuild after metadata drift; a mismatch fences it.
    revalidateBuild,
  };
}
