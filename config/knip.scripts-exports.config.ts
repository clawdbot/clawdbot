/**
 * Entry-export audit for repository scripts.
 *
 * Production configuration already owns the executable script roots. This
 * companion pass keeps the rest of scripts/** as library project files and
 * makes repository tests real consumers of deliberately testable helpers.
 */
import productionConfig from "./knip.config.ts";

const scriptEntries = productionConfig.workspaces["."].entry.filter((entry) =>
  entry.startsWith("scripts/"),
);

const repositoryToolEntries = [
  ".github/actions/register-bind-mount-cleanup/main.cjs!",
  ".github/actions/register-bind-mount-cleanup/post.cjs!",
  "apps/android/scripts/build-release-artifacts.ts!",
  "security/opengrep/check-rule-metadata.mjs!",
  "security/opengrep/compile-rules.mjs!",
  "skills/meme-maker/scripts/meme.mjs!",
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
    "scripts/e2e/secret-provider-integrations.mjs": [
      "exports",
      "nsExports",
      "types",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
    ],
    "scripts/repro/code-mode-namespace-live.ts": [
      "exports",
      "nsExports",
      "types",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
    ],
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
