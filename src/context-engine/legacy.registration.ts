import { LegacyContextEngine } from "./legacy.js";
import { registerContextEngineForOwner } from "./registry.js";

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner("legacy", async () => new LegacyContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}
