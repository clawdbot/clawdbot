import { createHash } from "node:crypto";

export const WORKER_BUNDLE_MANIFEST_VERSION = "openclaw-worker-bundle-v1";
export const WORKER_BUNDLE_ARTIFACT_MODE = 0o700;
export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";
export const WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH = "github-exec-launcher.mjs";
export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";

/** Immutable source archive within the running node's owning package, outside its dist inventory. */
export function workerBundleArchiveRelativePath(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Invalid worker bundle archive SHA-256");
  }
  return `worker-artifacts/${sha256}.tgz`;
}

export function compareWorkerBundlePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type WorkerBundleHashEntry = {
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

/** Hashes the canonical worker manifest shared by Gateway bundles and node-local installs. */
export function hashWorkerBundleManifest(entries: readonly WorkerBundleHashEntry[]): string {
  const hash = createHash("sha256");
  hash.update(`${WORKER_BUNDLE_MANIFEST_VERSION}\0`);
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}
