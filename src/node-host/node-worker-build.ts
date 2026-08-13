import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { collectWorkerBundleManifest } from "../gateway/worker-environments/bundle-staging.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import { VERSION } from "../version.js";

type NodeWorkerBuildOptions = {
  packageRoot?: string;
  openclawVersion?: string;
  protocolFeatures?: readonly string[];
};

/** Computes the build identity of the node host's own worker-capable installation. */
export async function resolveNodeWorkerBuild(
  options: NodeWorkerBuildOptions = {},
): Promise<WorkerAdmissionHandshake> {
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
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-worker-build-"));
  try {
    const manifest = await collectWorkerBundleManifest(packageRoot, stagingRoot);
    return {
      bundleHash: hashWorkerBundleManifest(manifest),
      openclawVersion: options.openclawVersion ?? VERSION,
      protocolFeatures: [...(options.protocolFeatures ?? WORKER_PROTOCOL_FEATURES)].toSorted(),
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
