import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensurePluginRegistryLoaded: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProvider: vi.fn(),
}));

vi.mock("../../plugins/runtime/runtime-registry-loader.js", () => ({
  ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolveActivatableProviderOwnerPluginIds: mocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: mocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider: mocks.resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef: mocks.resolveOwningPluginIdsForProvider,
}));

describe("ensureSelectedAgentHarnessPlugin", () => {
  let ensureSelectedAgentHarnessPlugin: typeof import("./runtime-plugin.js").ensureSelectedAgentHarnessPlugin;

  beforeEach(async () => {
    mocks.ensurePluginRegistryLoaded.mockReset();
    mocks.resolveActivatableProviderOwnerPluginIds.mockReset();
    mocks.resolveBundledProviderCompatPluginIds.mockReset();
    mocks.resolveOwningPluginIdsForProvider.mockReset();
    mocks.resolveOwningPluginIdsForProvider.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "openai" || provider === "openai-codex" ? ["openai"] : undefined,
    );
    mocks.resolveBundledProviderCompatPluginIds.mockImplementation(
      ({ onlyPluginIds }: { onlyPluginIds?: readonly string[] }) =>
        (onlyPluginIds ?? []).filter((pluginId) => pluginId === "openai"),
    );
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValue([]);
    vi.resetModules();
    ({ ensureSelectedAgentHarnessPlugin } = await import("./runtime-plugin.js"));
  });

  it("loads Codex and the provider owner when an explicit runtime override forces the Codex harness", async () => {
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
        onlyPluginIds: ["codex", "openai"],
      }),
    );
  });

  it("loads Codex and the provider owner for the implicit official OpenAI runtime before selection", async () => {
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
        onlyPluginIds: ["codex", "openai"],
      }),
    );
  });

  it("loads a configured Copilot harness plugin before selection", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "github-copilot",
      modelId: "gpt-4o",
      config: {
        models: {
          providers: {
            "github-copilot": {
              agentRuntime: { id: "copilot" },
              baseUrl: "https://api.githubcopilot.com",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["copilot"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["copilot"],
            entries: expect.objectContaining({
              copilot: expect.objectContaining({ enabled: true }),
            }),
          }),
        }),
      }),
    );
  });

  it("does not bypass a restrictive allowlist that omits a configured Copilot harness", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "github-copilot",
      modelId: "gpt-4o",
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
        models: {
          providers: {
            "github-copilot": {
              agentRuntime: { id: "copilot" },
              baseUrl: "https://api.githubcopilot.com",
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
        onlyPluginIds: ["copilot"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["telegram"],
            entries: expect.not.objectContaining({
              copilot: expect.anything(),
            }),
          }),
        }),
      }),
    );
  });

  it("widens a scoped harness allowlist with the provider owner for openai-codex models", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai-codex",
      modelId: "gpt-5.5-pro",
      config: {
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex", "openai"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["codex", "openai"],
            entries: expect.objectContaining({
              codex: expect.objectContaining({ enabled: true }),
              openai: expect.objectContaining({ enabled: true }),
            }),
          }),
        }),
      }),
    );
  });

  it("does not auto-activate untrusted provider owners for Codex harness loads", async () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai", "workspace-openai"]);
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce([]);

    await ensureSelectedAgentHarnessPlugin({
      provider: "openai-codex",
      modelId: "gpt-5.5-pro",
      config: {
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveBundledProviderCompatPluginIds).toHaveBeenCalledWith({
      config: expect.any(Object),
      workspaceDir: "/tmp/workspace",
      onlyPluginIds: ["openai", "workspace-openai"],
    });
    expect(mocks.resolveActivatableProviderOwnerPluginIds).toHaveBeenCalledWith({
      pluginIds: ["openai", "workspace-openai"],
      config: expect.any(Object),
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex", "openai"],
      }),
    );
  });

  it("does not bypass a restrictive allowlist that omits the Codex harness", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai-codex",
      modelId: "gpt-5.5-pro",
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
    expect(mocks.resolveBundledProviderCompatPluginIds).not.toHaveBeenCalled();
    expect(mocks.resolveActivatableProviderOwnerPluginIds).not.toHaveBeenCalled();
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["telegram"],
            entries: expect.not.objectContaining({
              codex: expect.anything(),
              openai: expect.anything(),
            }),
          }),
        }),
      }),
    );
  });

  it("keeps a Codex scoped load narrow when the provider has no owner plugin", async () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(undefined);

    await ensureSelectedAgentHarnessPlugin({
      provider: "custom-provider",
      modelId: "gpt-5.5",
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveBundledProviderCompatPluginIds).not.toHaveBeenCalled();
    expect(mocks.resolveActivatableProviderOwnerPluginIds).not.toHaveBeenCalled();
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex"],
      }),
    );
  });

  it("keeps custom OpenAI-compatible providers on embedded OpenClaw when no runtime override is set", async () => {
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
    expect(mocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
  });

  it("does not treat CLI backend runtime aliases as plugin ids", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      config: {
        models: {
          providers: {
            anthropic: {
              agentRuntime: { id: "claude-cli" },
              baseUrl: "https://api.anthropic.com",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(mocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
  });
});
