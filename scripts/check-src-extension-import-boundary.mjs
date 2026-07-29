#!/usr/bin/env node

// Runs the src/** extension import boundary checker.
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const ALLOWED_EXTENSION_PUBLIC_SURFACE_RE = /^extensions\/[^/]+\/(?:api|runtime-api)\.js$/;

const checker = createExtensionImportBoundaryChecker({
  roots: ["src"],
  boundaryLabel: "src",
  rule: "Rule: production src/** must not import bundled plugin files",
  cleanMessage: "No src import boundary violations found.",
  inventoryTitle: "Src extension import boundary inventory:",
  skipSourcesWithoutBundledPluginPrefix: true,
  allowResolvedPath(resolvedPath) {
    return ALLOWED_EXTENSION_PUBLIC_SURFACE_RE.test(resolvedPath);
  },
  shouldSkipFile(relativeFile) {
    return (
      relativeFile.endsWith(".test.ts") ||
      relativeFile.endsWith(".test.tsx") ||
      relativeFile.endsWith(".e2e.test.ts") ||
      relativeFile.endsWith(".e2e.test.tsx")
    );
  },
});

/**
 * Entrypoint for the src extension import boundary checker.
 */
export const main = checker.main;

runAsScript(import.meta.url, main);
