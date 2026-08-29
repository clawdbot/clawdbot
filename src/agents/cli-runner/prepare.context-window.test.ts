import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { applyDiscoveredContextWindows } from "../context-cache-projection.js";
import { getContextWindowCaches } from "../context-cache.js";
import { resetContextWindowCacheForTest } from "../context.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI context-window ownership", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    resetContextWindowCacheForTest();
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(() => {
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    resetContextWindowCacheForTest();
    fixture.cleanup();
  });

  it.each([
    { provider: "claude-cli", model: "claude-sonnet-4-6", catalogProvider: "anthropic" },
    { provider: "test-cli", model: "large-model", catalogProvider: "api-provider" },
  ])("keeps $provider stable when another provider loads the same model", async (testCase) => {
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(
      async () => undefined,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          id: testCase.provider,
          modelProvider: testCase.catalogProvider,
          prepareExecution,
        },
      ],
    });
    const prepare = () => fixture.prepare({ provider: testCase.provider, model: testCase.model });
    const cold = await prepare();
    expect(cold.contextWindowInfo?.tokens).toBe(200_000);

    // Discovery publishes both provider-qualified and bare keys. The latter cannot
    // supply a different runtime's native budget on the next turn.
    applyDiscoveredContextWindows({
      cache: getContextWindowCaches().discoveredTokenCache,
      models: [
        { provider: testCase.catalogProvider, id: testCase.model, contextWindow: 1_000_000 },
      ],
    });
    const resumed = await prepare();
    expect(resumed.contextWindowInfo?.tokens).toBe(200_000);

    // A provider-owned large window remains usable even without a manifest row.
    applyDiscoveredContextWindows({
      cache: getContextWindowCaches().discoveredTokenCache,
      models: [{ provider: testCase.provider, id: testCase.model, contextWindow: 1_000_000 }],
    });
    const owned = await prepare();
    expect(owned.contextWindowInfo?.tokens).toBe(1_000_000);
    expect(prepareExecution.mock.calls.map(([context]) => context.contextTokenBudget)).toEqual([
      200_000, 200_000, 1_000_000,
    ]);
  });
});
