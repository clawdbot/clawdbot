#!/usr/bin/env node

// Runs the SDK-package extension import boundary checker.
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const checker = createExtensionImportBoundaryChecker({
  roots: ["src/plugin-sdk", "packages"],
  boundaryLabel: "sdk/package",
  rule: "Rule: src/plugin-sdk/** and packages/** must not import bundled plugin files",
  cleanMessage: "No sdk/package import boundary violations found.",
  inventoryTitle: "SDK/package extension import boundary inventory:",
  skipSourcesWithoutBundledPluginPrefix: true,
  shouldSkipFile(relativeFile) {
    return relativeFile.startsWith("packages/plugin-sdk/dist/");
  },
});

/**
 * Entrypoint for the SDK-package extension import boundary checker.
 */
export const main = checker.main;

runAsScript(import.meta.url, main);
