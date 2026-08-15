import { createHash } from "node:crypto";

export const WORKER_BUNDLE_MANIFEST_VERSION = "openclaw-worker-bundle-v1";

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
