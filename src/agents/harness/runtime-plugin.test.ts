import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));

vi.mock("../../plugins/runtime/runtime-registry-loader.js", () => ({
  ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
}));

describe("ensureSelectedAgentHarnessPlugin", () => {
  let ensureSelectedAgentHarnessPlugin: typeof import("./runtime-plugin.js").ensureSelectedAgentHarnessPlugin;

  beforeEach(async () => {
    mocks.ensurePluginRegistryLoaded.mockReset();
    vi.resetModules();
    ({ ensureSelectedAgentHarnessPlugin } = await import("./runtime-plugin.js"));
  });

  it("loads Codex when an explicit runtime override forces the Codex harness", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai-compatible.example.test/v1",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex"],
      }),
    );
  });

  it("tries to load Codex for the implicit official OpenAI runtime before selection", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex"],
      }),
    );
  });

  it("keeps custom OpenAI-compatible providers on Pi when no runtime override is set", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai-compatible.example.test/v1",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });
});
