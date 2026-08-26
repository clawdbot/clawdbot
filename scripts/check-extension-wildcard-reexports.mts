#!/usr/bin/env node

// Rejects local wildcard re-exports in guarded extension API barrels.
import {
  createExtensionWildcardReexportScanner,
  type ExtensionWildcardReexportPolicy,
} from "./lib/extension-wildcard-reexport-scanner.mts";

const LOCAL_WILDCARD_REEXPORT_PATTERN = /^\s*export\s+(?:type\s+)?\*\s+from\s+["'](?:\.{1,2}\/)/u;
const policy = {
  // Local wildcard pinning also protects nested implementation barrels.
  fileScope: "all-extension-api-files",
  pattern: LOCAL_WILDCARD_REEXPORT_PATTERN,
  successMessage: "No guarded extension wildcard re-exports found.",
  findingsMessage: "Found guarded extension wildcard re-exports:",
  remediationMessage: "Use explicit named exports so runtime and public API barrels stay pinned.",
} satisfies ExtensionWildcardReexportPolicy;
const scanner = createExtensionWildcardReexportScanner(policy);

/**
 * Finds local wildcard re-export lines in a barrel source string.
 */
export const findLocalWildcardReexports = scanner.findLines;

/**
 * Runs the extension wildcard re-export guard.
 */
export const main = scanner.main;

await scanner.exitIfMain(import.meta.url);
