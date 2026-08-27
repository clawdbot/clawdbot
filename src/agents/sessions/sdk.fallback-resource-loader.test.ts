// Fallback resource-loader tests: config I/O is loaded lazily only when the SDK
// has to construct its own DefaultResourceLoader.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { Model } from "../../llm/types.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const configIoMocks = vi.hoisted(() => ({
  readBestEffortConfig: vi.fn(() => ({ skills: { limits: { maxSkillFileBytes: 123_456 } } })),
}));

vi.mock("../../config/io.runtime.js", () => ({
  readBestEffortConfig: configIoMocks.readBestEffortConfig,
}));

const sdkSessionTempDirs = useAutoCleanupTempDirTracker(afterEach);

const testModel = {
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
} as Model;

function createEmptyResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getSkillFileSizeLimit: () => 256_000,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

describe("createAgentSession fallback resource loader", () => {
  it("loads config I/O lazily only for the fallback resource loader", async () => {
    configIoMocks.readBestEffortConfig.mockClear();

    await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(configIoMocks.readBestEffortConfig).not.toHaveBeenCalled();
  });

  it("uses the fallback resource loader when none is provided", async () => {
    const root = sdkSessionTempDirs.make("openclaw-sdk-fallback-loader-");
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "cwd");

    const { session } = await createAgentSession({
      agentDir,
      cwd,
      model: testModel,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(configIoMocks.readBestEffortConfig).toHaveBeenCalledWith({
      skipPluginValidation: true,
      isolateEnv: true,
      observe: false,
    });
    expect(session.resourceLoader).toBeDefined();
  });
});
