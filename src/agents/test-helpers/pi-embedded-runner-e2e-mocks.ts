import { vi } from "vitest";

export function installEmbeddedRunnerBaseE2eMocks(options?: {
  hookRunner?: "minimal" | "full";
}): void {
  vi.doMock("../../plugins/hook-runner-global.js", () =>
    options?.hookRunner === "full"
      ? {
          getGlobalHookRunner: vi.fn(() => undefined),
          getGlobalPluginRegistry: vi.fn(() => null),
          hasGlobalHooks: vi.fn(() => false),
          initializeGlobalHookRunner: vi.fn(),
          resetGlobalHookRunner: vi.fn(),
        }
      : {
          getGlobalHookRunner: vi.fn(() => undefined),
        },
  );
  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));
  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: vi.fn(async () => ({
      dispose: async () => undefined,
    })),
  }));
  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: vi.fn(),
  }));
}
