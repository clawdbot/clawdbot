/** Test-only helpers for host integration tests that exercise Memory Wiki composition. */
export {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  invalidateMemoryWikiCompiledCache,
} from "./src/compiled-cache.js";
export {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  type ResolvedMemoryWikiConfig,
} from "./src/config.js";
export { compileMemoryWikiVault } from "./src/compile.js";
export { renderWikiMarkdown } from "./src/markdown.js";
export { createWikiPromptSectionPreparer } from "./src/prompt-section.js";
export { createMemoryWikiTestHarness } from "./src/test-helpers.js";
export { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./src/vault.js";
