import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { WORKER_BUNDLE_ENTRY_PATH } from "../shared/worker-bundle-hash.js";

/** Resolves one exact Gateway-managed worker bundle from its isolated namespace. */
export function resolveNodeWorkerEntry(params: {
  bundleRoot: string;
  expectedBundleHash: string;
  gatewayNamespace: string;
}): string {
  const root = fs.realpathSync.native(params.bundleRoot);
  const bundle = fs.realpathSync.native(
    path.join(root, params.gatewayNamespace, "bundles", params.expectedBundleHash),
  );
  if (!isPathInside(root, bundle)) {
    throw new Error("node worker bundle resolves outside its configured root");
  }
  const entry = fs.realpathSync.native(path.join(bundle, WORKER_BUNDLE_ENTRY_PATH));
  if (!isPathInside(bundle, entry) || !fs.statSync(entry).isFile()) {
    throw new Error("node worker entry must be a regular file inside its bundle");
  }
  return entry;
}
