import path from "node:path";
import { resolveIsNixMode } from "../config/paths.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const NIX_STORE_ROOT = "/nix/store";

// Hardlinks are rejected for user/config/workspace plugin roots by default. A
// hardlinked file can appear to live under a plugin root while sharing an inode
// with a file created elsewhere, which weakens the root-boundary checks used
// before loading plugin code.
//
// Two roots are allowed:
// - bundled: plugins shipped with OpenClaw itself, not user-installed code.
// - /nix/store in OPENCLAW_NIX_MODE: immutable Nix package outputs, where
//   hardlinked files are normal package-store layout rather than user mutation.
export function isNixStorePluginRoot(
  rootDir: string,
  realpathCache?: Map<string, string>,
): boolean {
  const rootRealPath = safeRealpathSync(rootDir, realpathCache) ?? path.resolve(rootDir);
  return rootRealPath === NIX_STORE_ROOT || rootRealPath.startsWith(`${NIX_STORE_ROOT}/`);
}

export function shouldRejectHardlinkedPluginFiles(params: {
  origin: PluginOrigin;
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  realpathCache?: Map<string, string>;
}): boolean {
  if (params.origin === "bundled") {
    return false;
  }
  if (resolveIsNixMode(params.env) && isNixStorePluginRoot(params.rootDir, params.realpathCache)) {
    return false;
  }
  return true;
}
