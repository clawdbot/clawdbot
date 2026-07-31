// Verifies plugin loading needed before agent harness selection.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensurePluginRegistryLoaded: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveManifestActivationPlan: vi.fn(),
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

vi.mock("../../plugins/activation-planner.js", () => ({
  resolveManifestActivationPlan: mocks.resolveManifestActivationPlan,
}));

describe("ensureSelectedAgentHarnessPlugin", () => {
  let ensureSelectedAgentHarnessPlugin: typeof import("./runtime-plugin.js").ensureSelectedAgentHarnessPlugin;
  let resolveAgentHarnessRuntimeAvailability: typeof import("./runtime-plugin.js").resolveAgentHarnessRuntimeAvailability;

  beforeAll(async () => {
    vi.resetModules();
    ({ ensureSelectedAgentHarnessPlugin, resolveAgentHarnessRuntimeAvailability } =
      await import("./runtime-plugin.js"));
  });

  beforeEach(() => {
    mocks.ensurePluginRegistryLoaded.mockReset();
    mocks.resolveActivatableProviderOwnerPluginIds.mockReset();
    mocks.resolveBundledProviderCompatPluginIds.mockReset();
    mocks.resolveManifestActivationPlan.mockReset();
    mocks.resolveOwningPluginIdsForProvider.mockReset();
    mocks.resolveManifestActivationPlan.mockImplementation(
      ({
        trigger,
        config,
      }: {
        trigger: { kind: "agentHarness"; runtime: string };
        config?: OpenClawConfig;
      }) => {
        const pluginId = trigger.runtime;
        const allow = config?.plugins?.allow ?? [];
        if (
          config?.plugins?.entries?.[pluginId]?.enabled === false ||
          (allow.length > 0 && !allow.includes(pluginId))
        ) {
          return { entries: [] };
        }
        return {
          entries:
            pluginId === "codex" || pluginId === "copilot" ? [{ pluginId, origin: "bundled" }] : [],
        };
      },
    );
    mocks.resolveOwningPluginIdsForProvider.mockImplementation(
      ({ provider }: { provider: string }) => (provider === "openai" ? ["openai"] : undefined),
    );
    mocks.resolveBundledProviderCompatPluginIds.mockImplementation(
      ({ onlyPluginIds }: { onlyPluginIds?: readonly string[] }) =>
        (onlyPluginIds ?? []).filter((pluginId) => pluginId === "openai"),
    );
    mocks.resolveActivatableProviderOwnerPluginIds.mockImplementation(
      ({ pluginIds }: { pluginIds: readonly string[] }) =>
        pluginIds.filter((pluginId) => pluginId === "memory-core"),
    );
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
        onlyPluginIds: ["codex", "openai", "memory-core"],
      }),
    );
  });

  it("reports a manifest-owned harness as statically available", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(undefined);

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toEqual({
      status: "available",
      ownerPluginIds: ["codex"],
    });
  });

  it("reports a harness unavailable when no enabled owner plugin can activate", () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: [],
        selectedPluginRootDirs: new Map(),
      }),
    ).toEqual({
      status: "unavailable",
      ownerPluginIds: [],
      reason: "owner-plugin-not-activatable",
      detail: 'No enabled plugin owns agent harness "codex".',
    });
  });

  it("reports a harness unavailable when startup quarantined an owner payload", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(undefined);

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [
          {
            pluginId: "codex",
            installPath: "/tmp/plugins/codex",
            reason: "missing-package-dir",
          },
        ],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toEqual({
      status: "unavailable",
      ownerPluginIds: ["codex"],
      reason: "owner-plugin-degraded",
      detail: 'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
    });
  });

  it("ignores a payload failure from a stale artifact with the same plugin id", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(undefined);

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [
          {
            pluginId: "codex",
            installPath: "/tmp/plugins/stale-codex",
            reason: "missing-package-dir",
          },
        ],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/active-codex"]]),
      }),
    ).toEqual({
      status: "available",
      ownerPluginIds: ["codex"],
    });
  });

  it("reports a selected owner unavailable when its payload was not checked", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(undefined);

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: [],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toEqual({
      status: "unavailable",
      ownerPluginIds: ["codex"],
      reason: "owner-plugin-unverified",
      detail: 'Agent harness "codex" owner plugin "codex" payload was not verified.',
    });
  });

  it("loads a session-pinned Codex harness for an unrelated outer provider", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentHarnessId: "codex",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveManifestActivationPlan).toHaveBeenCalledWith({
      trigger: { kind: "agentHarness", runtime: "codex" },
      config: undefined,
      workspaceDir: "/tmp/workspace",
      requireExplicitManifestOwnerTrust: true,
    });
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: expect.arrayContaining(["codex"]),
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
        onlyPluginIds: ["codex", "openai", "memory-core"],
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
        onlyPluginIds: ["copilot", "memory-core"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["copilot", "memory-core"],
            entries: expect.objectContaining({
              copilot: expect.objectContaining({ enabled: true }),
            }),
          }),
        }),
      }),
    );
  });

  it("loads a manifest-owned custom harness runtime before selection", async () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({
      entries: [{ pluginId: "custom-harness-plugin", origin: "workspace" }],
    });

    await ensureSelectedAgentHarnessPlugin({
      provider: "custom-provider",
      modelId: "custom-model",
      config: {
        plugins: {
          entries: {
            "custom-harness-plugin": { enabled: true },
          },
        },
      } as OpenClawConfig,
      agentHarnessRuntimeOverride: "custom-harness",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveManifestActivationPlan).toHaveBeenCalledWith({
      trigger: { kind: "agentHarness", runtime: "custom-harness" },
      config: expect.any(Object),
      workspaceDir: "/tmp/workspace",
      requireExplicitManifestOwnerTrust: true,
    });
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["custom-harness-plugin", "memory-core"],
      }),
    );
  });

  it("does not activate an untrusted workspace harness from manifest metadata alone", async () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({
      entries: [],
    });

    await ensureSelectedAgentHarnessPlugin({
      provider: "custom-provider",
      modelId: "custom-model",
      agentHarnessRuntimeOverride: "custom-harness",
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveManifestActivationPlan).toHaveBeenCalledWith({
      trigger: { kind: "agentHarness", runtime: "custom-harness" },
      config: undefined,
      workspaceDir: "/tmp/workspace",
      requireExplicitManifestOwnerTrust: true,
    });
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("does not bypass a restrictive allowlist that omits a configured Copilot harness", async () => {
    // A configured harness can request loading, but explicit plugin allowlists
    // remain the operator's boundary and are not widened implicitly.
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

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("widens a scoped harness allowlist with the provider owner for openai models", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
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

  it("keeps an allowed memory slot plugin in Codex harness scoped loads", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      config: {
        plugins: {
          allow: ["codex", "openai", "memory-core"],
          entries: {
            codex: { enabled: true },
            openai: { enabled: true },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex", "openai", "memory-core"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["codex", "openai", "memory-core"],
            entries: expect.objectContaining({
              codex: expect.objectContaining({ enabled: true }),
              openai: expect.objectContaining({ enabled: true }),
              "memory-core": expect.objectContaining({ enabled: true }),
            }),
          }),
        }),
      }),
    );
  });

  it("does not auto-activate an untrusted workspace memory slot plugin", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      config: {
        plugins: {
          slots: { memory: "workspace-memory" },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
    });

    expect(mocks.resolveActivatableProviderOwnerPluginIds).toHaveBeenCalledWith({
      pluginIds: ["openai"],
      config: expect.any(Object),
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.resolveActivatableProviderOwnerPluginIds).not.toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["workspace-memory"] }),
    );
    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["codex", "openai"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.not.objectContaining({
              "workspace-memory": expect.anything(),
            }),
          }),
        }),
      }),
    );
  });

  it("does not auto-activate untrusted provider owners for Codex harness loads", async () => {
    // Provider owner activation is limited to bundled-compatible/activatable
    // owners so workspace plugins are not enabled just because Codex was chosen.
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai", "workspace-openai"]);
    mocks.resolveBundledProviderCompatPluginIds.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce([]);

    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
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
      provider: "openai",
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
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("keeps real bundled memory-core in a Codex scoped load when the provider has no owner plugin", async () => {
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
        onlyPluginIds: ["codex", "memory-core"],
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

  it("keeps official OpenAI providers on embedded OpenClaw when explicitly configured", async () => {
    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.2",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
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
    expect(mocks.resolveManifestActivationPlan).not.toHaveBeenCalled();
  });
});
