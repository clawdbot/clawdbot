#!/usr/bin/env node

// Rejects wildcard plugin SDK re-exports in extension API barrels.
import {
  createExtensionWildcardReexportScanner,
  type ExtensionWildcardReexportPolicy,
} from "./lib/extension-wildcard-reexport-scanner.mts";

const WILDCARD_PLUGIN_SDK_REEXPORT_PATTERN =
  /^\s*export\s+(?:type\s+)?\*\s+(?:as\s+[$\w]+\s+)?from\s+["']openclaw\/plugin-sdk\//u;
const policy = {
  // SDK wildcard exposure is only a public extension-root barrel policy.
  fileScope: "extension-root-api-files",
  pattern: WILDCARD_PLUGIN_SDK_REEXPORT_PATTERN,
  successMessage: "No plugin-sdk wildcard re-exports found in extension API barrels.",
  findingsMessage: "Found plugin-sdk wildcard re-exports in extension API barrels:",
  remediationMessage: "Use explicit named exports from the narrow SDK subpath instead.",
} satisfies ExtensionWildcardReexportPolicy;
const scanner = createExtensionWildcardReexportScanner(policy);

/**
 * Finds wildcard plugin SDK re-export lines in an extension API barrel.
 */
export const findPluginSdkWildcardReexports = scanner.findLines;

/**
 * Runs the plugin SDK wildcard re-export guard.
 */
export const main = scanner.main;

await scanner.exitIfMain(import.meta.url);
