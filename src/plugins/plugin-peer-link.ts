import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

type PluginPeerLinkLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Symlink the host openclaw package for plugins that declare it as a peer.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export async function linkOpenClawPeerDependencies(params: {
  installedDir: string;
  peerDependencies: Record<string, string>;
  logger: PluginPeerLinkLogger;
}): Promise<void> {
  const peers = Object.keys(params.peerDependencies).filter((name) => name === "openclaw");
  if (peers.length === 0) {
    return;
  }

  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    params.logger.warn?.(
      "Could not locate openclaw package root to symlink peerDependencies; plugin may fail to resolve openclaw at runtime.",
    );
    return;
  }

  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  await fs.mkdir(nodeModulesDir, { recursive: true });

  for (const peerName of peers) {
    const linkPath = path.join(nodeModulesDir, peerName);

    try {
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.symlink(hostRoot, linkPath, "junction");
      params.logger.info?.(`Linked peerDependency "${peerName}" -> ${hostRoot}`);
    } catch (err) {
      params.logger.warn?.(`Failed to symlink peerDependency "${peerName}": ${String(err)}`);
    }
  }
}
