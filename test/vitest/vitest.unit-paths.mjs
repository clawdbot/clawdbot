import path from "node:path";
import { BUNDLED_PLUGIN_ROOT_DIR } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const unitTestIncludePatterns = [
  "src/**/*.test.ts",
  "packages/**/*.test.ts",
  "test/**/*.test.ts",
  "ui/src/ui/app-chat.test.ts",
  "ui/src/ui/chat/**/*.test.ts",
  "ui/src/ui/views/agents-utils.test.ts",
  "ui/src/ui/views/channels.test.ts",
  "ui/src/ui/views/chat.test.ts",
  "ui/src/ui/views/dreams.test.ts",
  "ui/src/ui/views/usage-render-details.test.ts",
  "ui/src/ui/controllers/agents.test.ts",
  "ui/src/ui/controllers/chat.test.ts",
];

export const boundaryTestFiles = [
  "src/infra/boundary-path.test.ts",
  "src/infra/git-root.test.ts",
  "src/infra/home-dir.test.ts",
  "src/infra/openclaw-exec-env.test.ts",
  "src/infra/openclaw-root.test.ts",
  "src/infra/package-json.test.ts",
  "src/infra/path-env.test.ts",
  "src/infra/stable-node-path.test.ts",
  "test/extension-import-boundaries.test.ts",
  "test/extension-test-boundary.test.ts",
  "test/plugin-extension-import-boundary.test.ts",
  "test/web-provider-boundary.test.ts",
];

export const bundledPluginDependentUnitTestFiles = [
  "src/infra/matrix-plugin-helper.test.ts",
  "src/plugin-sdk/facade-runtime.test.ts",
  "src/plugins/loader.test.ts",
];

export const unitTestAdditionalExcludePatterns = [
  "src/gateway/**",
  "src/hooks/**",
  "src/infra/**",
  `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
  "src/browser/**",
  "src/line/**",
  "src/agents/**",
  "src/auto-reply/**",
  "src/channels/**",
  "src/cli/**",
  "src/commands/**",
  "src/config/**",
  "src/cron/**",
  "src/daemon/**",
  "src/media/**",
  "src/plugin-sdk/**",
  "src/plugins/**",
  "src/process/**",
  "src/secrets/**",
  "src/shared/**",
  "src/tasks/**",
  "src/media-understanding/**",
  "src/logging/**",
  "src/tui/**",
  "src/utils/**",
  "src/wizard/**",
  "src/plugins/contracts/**",
  "src/scripts/**",
  "src/infra/boundary-path.test.ts",
  "src/infra/git-root.test.ts",
  "src/infra/home-dir.test.ts",
  "src/infra/openclaw-exec-env.test.ts",
  "src/infra/openclaw-root.test.ts",
  "src/infra/package-json.test.ts",
  "src/infra/path-env.test.ts",
  "src/infra/stable-node-path.test.ts",
  ...bundledPluginDependentUnitTestFiles,
  "src/config/doc-baseline.integration.test.ts",
  "src/config/schema.base.generated.test.ts",
  "src/config/schema.help.quality.test.ts",
  "test/**",
];

const sharedBaseExcludePatterns = [
  "dist/**",
  "apps/macos/**",
  "apps/macos/.build/**",
  "**/node_modules/**",
  "**/vendor/**",
  "dist/OpenClaw.app/**",
  "**/*.live.test.ts",
  "**/*.e2e.test.ts",
];

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const matchesAny = (file, patterns) => patterns.some((pattern) => path.matchesGlob(file, pattern));

export function isUnitConfigTestFile(file) {
  const normalizedFile = normalizeRepoPath(file);
  return (
    matchesAny(normalizedFile, unitTestIncludePatterns) &&
    !matchesAny(normalizedFile, sharedBaseExcludePatterns) &&
    !matchesAny(normalizedFile, unitTestAdditionalExcludePatterns)
  );
}

export function isBundledPluginDependentUnitTestFile(file) {
  return bundledPluginDependentUnitTestFiles.includes(normalizeRepoPath(file));
}

export function isBoundaryTestFile(file) {
  return boundaryTestFiles.includes(normalizeRepoPath(file));
}
