// Legacy context-engine registration installs the built-in fallback under core ownership.
import { LegacyContextEngine } from "./legacy.js";
import { registerContextEngineForOwner } from "./registry.js";

// Registers the built-in legacy context engine under the core owner. Refresh is
// allowed so tests/bootstrap can re-register after module-state resets.
export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner("legacy", async () => new LegacyContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}
