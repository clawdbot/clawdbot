import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { NodeWorkerLaunchInput } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerInstallation } from "./node-worker-build.js";

/** Resolves an explicitly selected worker install without crossing local/bundle trust modes. */
export async function resolveNodeWorkerEntry(params: {
  bundleRoot: string;
  installKind: NodeWorkerLaunchInput["installKind"];
  expectedBundleHash: string;
  gatewayNamespace: string;
  localInstallation?: NodeWorkerInstallation;
}): Promise<string> {
  if (params.installKind === "local") {
    const installation = params.localInstallation;
    if (!installation || installation.build.bundleHash !== params.expectedBundleHash) {
      throw new Error("node worker local install does not match its advertised build");
    }
    if (!(await installation.revalidateBuild())) {
      throw new Error("node worker local install changed after its build was advertised");
    }
    const root = fs.realpathSync.native(installation.packageRoot);
    const entry = fs.realpathSync.native(path.join(root, "openclaw.mjs"));
    if (!isPathInside(root, entry) || !fs.statSync(entry).isFile()) {
      throw new Error("node worker local entry must be a regular file inside its install");
    }
    return entry;
  }
  const root = fs.realpathSync.native(params.bundleRoot);
  const bundle = fs.realpathSync.native(
    path.join(root, params.gatewayNamespace, "bundles", params.expectedBundleHash),
  );
  if (!isPathInside(root, bundle)) {
    throw new Error("node worker bundle resolves outside its configured root");
  }
  const entry = fs.realpathSync.native(path.join(bundle, "openclaw.mjs"));
  if (!isPathInside(bundle, entry) || !fs.statSync(entry).isFile()) {
    throw new Error("node worker entry must be a regular file inside its bundle");
  }
  return entry;
}
