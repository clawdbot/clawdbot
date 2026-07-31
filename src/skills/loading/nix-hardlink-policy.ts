// Centralized Nix store hardlink policy for skill/plugin file loading.
// Aligns with the existing plugin module-loader rule: rejectHardlinks: false
// when running in Nix mode AND the resolved path is under /nix/store.

import { isNixMode } from "../../config/paths.js";

const NIX_STORE_ROOT = "/nix/store";

/**
 * Determines whether hardlinks should be rejected for a given resolved path.
 * Returns false (allow hardlinks) only when:
 * - Nix mode is enabled (OPENCLAW_NIX_MODE=1), AND
 * - The path is under /nix/store
 *
 * NixOS auto-optimise-store deduplicates identical files across the store by
 * hardlinking them. This is a standard Nix optimisation, not user mutation.
 * Rejecting hardlinks would silently drop every skill/plugin in the Nix store.
 *
 * All other paths reject hardlinks for security.
 */
export function shouldRejectHardlinks(resolvedPath: string): boolean {
  // Require Nix mode to be explicitly enabled
  if (!isNixMode) {
    return true;
  }
  // Require canonical resolved path under /nix/store
  const isNixStorePath =
    resolvedPath === NIX_STORE_ROOT || resolvedPath.startsWith(`${NIX_STORE_ROOT}/`);
  return !isNixStorePath;
}
