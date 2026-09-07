/**
 * Entry-export audit for repository scripts.
 *
 * Production configuration already owns the executable script roots. This
 * companion pass keeps the rest of scripts/** as library project files and
 * makes repository tests real consumers of deliberately testable helpers.
 */
import fs from "node:fs";
import productionConfig from "./knip.config.ts";

function isTypedShimImplementationEntry(entry: string): boolean {
  const filePath = entry.endsWith("!") ? entry.slice(0, -1) : entry;
  // The export-free Crabbox implementation must remain a root so its library imports stay live.
  if (!filePath.endsWith(".mts") || filePath === "scripts/crabbox-wrapper.mts") {
    return false;
  }
  const basePath = filePath.slice(0, -".mts".length);
  return fs.existsSync(`${basePath}.mjs`) || fs.existsSync(`${basePath}.js`);
}

const scriptEntries = productionConfig.workspaces["."].entry.filter(
  (entry) => entry.startsWith("scripts/") && !isTypedShimImplementationEntry(entry),
);

const repositoryToolEntries = [
  ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
  "apps/android/scripts/build-release-artifacts.ts!",
  "security/opengrep/check-rule-metadata.mjs!",
  "security/opengrep/compile-rules.mjs!",
  "skills/meme-maker/scripts/meme.mjs!",
  "scripts/check-openclaw-package-tarball.mts!",
] as const;

const config = {
  ignoreWorkspaces: ["apps/**", "extensions/**", "packages/**", "ui"],
  ignore: ["scripts/**/*.d.{mts,cts,ts}", "scripts/**/*.test-support.{js,mjs,cjs,ts,mts,cts}"],
  // Script entrypoints import core and Plugin SDK APIs. Those owners are
  // checked by the application scans; this pass owns only scripts/** exports.
  ignoreIssues: {
    // These executable modules are also loaded through variable/file-URL imports
    // by build or subprocess test harnesses, which Knip cannot resolve statically.
    "scripts/diffs-shiki-curated.ts": [
      "exports",
      "nsExports",
      "types",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
    ],
    "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs": [
      "exports",
      "nsExports",
      "types",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
    ],
    // Oxlint consumes this required default export through a JSON config path.
    "scripts/oxlint-boundary-guards.mjs": ["exports"],
    // Vitest consumes this required default export through the reporter CLI path.
    "scripts/lib/vitest-resource-reporter.mts": ["exports"],
    // Wrangler consumes the Worker default export and instantiates the Durable
    // Object class by name from wrangler.jsonc; Knip cannot resolve either.
    "scripts/cloudflare/src/index.ts": ["exports"],
    "scripts/cloudflare/src/container.ts": ["exports"],
    "src/**": ["exports", "nsExports", "types", "nsTypes", "enumMembers", "namespaceMembers"],
    "test/**": ["exports", "nsExports", "types", "nsTypes", "enumMembers", "namespaceMembers"],
  },
  workspaces: {
    ".": {
      entry: [
        ...scriptEntries,
        ...repositoryToolEntries,
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "src/plugin-sdk/api-baseline.ts!",
      ],
      project: [
        ".github/actions/**/*.{js,mjs,cjs,ts,mts,cts}!",
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "apps/android/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "security/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "skills/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "src/plugin-sdk/api-baseline.ts!",
      ],
    },
  },
};

export default config;
