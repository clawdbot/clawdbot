// Context-engine initialization registers built-in engines before plugin resolution.
import { registerLegacyContextEngine } from "./legacy.registration.js";

/**
 * Ensures all built-in context engines are registered in the active registry.
 *
 * The legacy engine is always registered as a safe fallback so that
 * `resolveContextEngine()` can resolve the default "legacy" slot without
 * callers needing to remember manual registration.
 *
 * Additional engines are registered by their own plugins via
 * `api.registerContextEngine()` during plugin load.
 */
export function ensureContextEnginesInitialized(): void {
  // Always available – safe fallback for the "legacy" slot default.
  registerLegacyContextEngine();
}
