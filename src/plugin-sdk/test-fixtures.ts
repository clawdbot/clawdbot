// Focused public test helpers for generic fixtures shared by plugin tests.

export {
  createCliRuntimeCapture,
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../cli/test-runtime-capture.js";
export type { CliMockOutputRuntime, CliRuntimeCapture } from "../cli/test-runtime-capture.js";
export { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
export {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "./test-helpers/sandbox-fixtures.js";
export { writeSkill } from "../agents/skills.e2e-test-helpers.js";
export {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../agents/test-helpers/agent-message-fixtures.js";
export { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
export { sanitizeTerminalText } from "../terminal/safe-text.js";
export { countLines, hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
export { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";
export { typedCases } from "../test-utils/typed-cases.js";
export {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
  bundledDistPluginFile,
  bundledDistPluginFileAt,
  bundledDistPluginRoot,
  bundledDistPluginRootAt,
  bundledPluginDirPrefix,
  bundledPluginFile,
  bundledPluginFileAt,
  bundledPluginRoot,
  bundledPluginRootAt,
  installedPluginRoot,
  repoInstallSpec,
} from "./test-helpers/bundled-plugin-paths.js";
export { importFreshModule } from "./test-helpers/import-fresh.js";
