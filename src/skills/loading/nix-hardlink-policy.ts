// Centralized Nix store hardlink policy for skill file loading.
// Reuses the canonical plugin hardlink policy from src/plugins/hardlink-policy.ts
// to ensure skills and plugins share the same Nix boundary exception.

import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";

/**
 * Determines whether hardlinks should be rejected for a given skill root.
 * Delegates to the canonical plugin hardlink policy with origin "workspace"
 * (skills are workspace-loaded, not bundled).
 *
 * Returns false (allow hardlinks) only when:
 * - Nix mode is enabled (OPENCLAW_NIX_MODE=1), AND
 * - The resolved path is under /nix/store
 *
 * NixOS auto-optimise-store deduplicates identical files across the store by
 * hardlinking them. This is a standard Nix optimisation, not user mutation.
 * Rejecting hardlinks would silently drop every skill in the Nix store.
 *
 * All other paths reject hardlinks for security.
 */
export function shouldRejectHardlinks(resolvedPath: string): boolean {
  return shouldRejectHardlinkedPluginFiles({
    origin: "workspace",
    rootDir: resolvedPath,
  });
}
