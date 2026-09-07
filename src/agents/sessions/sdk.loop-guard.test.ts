import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import {
  resolveLoopGuardRuntimeConfig,
  type LoopGuardRuntimeConfig,
} from "../tool-loop-detection-config.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

// Loop-guard config application on the plain session factory (#120962). Split
// from sdk.test.ts so that file stays within the max-lines budget.

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const streamMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
}));

function createResourceLoaderWithHandlers(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createEmptyResourceLoader(): ResourceLoader {
  return createResourceLoaderWithHandlers(new Map());
}

function createTestModelRegistry(authStorage = AuthStorage.inMemory()): ModelRegistry {
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  for (const api of ["openai-responses", "bedrock-converse-stream"] as const) {
    modelRegistry.registerProvider(`test-${api}`, {
      api,
      streamSimple: streamMocks.streamSimple,
    });
  }
  return modelRegistry;
}

describe("createAgentSession loop-guard config", () => {
  it("applies config-resolved loop guards on the plain session factory", async () => {
    const modelRegistry = createTestModelRegistry();
    const readGuards = async (loopGuardConfig: LoopGuardRuntimeConfig) => {
      const { session } = await createAgentSession({
        model: testModel,
        resourceLoader: createEmptyResourceLoader(),
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory(),
        modelRegistry,
        loopGuardConfig,
      });
      const guards = {
        maxTurns: session.agent.maxTurns,
        maxConsecutiveErrorBatches: session.agent.maxConsecutiveErrorBatches,
        maxIdleRepeatCalls: session.agent.maxIdleRepeatCalls,
      };
      session.dispose();
      return guards;
    };

    // Configless (no tools.loopDetection block anywhere): guards stay off,
    // preserving pre-guard runtime behavior (opt-in product policy).
    await expect(readGuards(resolveLoopGuardRuntimeConfig({}))).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });

    // An explicit tools.loopDetection block without any guard key does NOT
    // engage any guard (opt-in: a guard key is the activation path, so an
    // existing {} block or enabled:true alone stays off on upgrade).
    await expect(
      readGuards(
        resolveLoopGuardRuntimeConfig({
          cfg: { tools: { loopDetection: {} } },
        }),
      ),
    ).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });

    // enabled:true alone does NOT activate hard cutoffs — it only activates
    // the existing rolling-history detectors. At least one guard key is
    // required to engage a hard cutoff.
    await expect(
      readGuards(
        resolveLoopGuardRuntimeConfig({
          cfg: { tools: { loopDetection: { enabled: true } } },
        }),
      ),
    ).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });

    // The `tools.loopDetection.enabled: false` kill switch reaches the plain
    // factory too: every guard is off even if guard keys are set.
    await expect(
      readGuards(
        resolveLoopGuardRuntimeConfig({
          cfg: { tools: { loopDetection: { enabled: false, turnLimit: 7 } } },
        }),
      ),
    ).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });

    // Setting a guard key activates that guard with the configured value;
    // other guards without keys stay off.
    await expect(
      readGuards(
        resolveLoopGuardRuntimeConfig({
          cfg: { tools: { loopDetection: { enabled: true, turnLimit: 7 } } },
        }),
      ),
    ).resolves.toEqual({
      maxTurns: 7,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });
});
