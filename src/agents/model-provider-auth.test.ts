import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
}));

const modelAuthMocks = vi.hoisted(() => ({
  hasRuntimeAvailableProviderAuth:
    vi.fn<(params: { provider: string; cfg?: OpenClawConfig; workspaceDir?: string }) => boolean>(),
}));

const authProfilesMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ profiles: {} })),
  externalCliDiscoveryForProviders: vi.fn(() => ({}) as never),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({}) as never),
  listProfilesForProvider: vi.fn(() => []),
}));

vi.mock("./model-catalog.js", () => ({
  loadModelCatalog: modelCatalogMocks.loadModelCatalog,
}));

vi.mock("./model-auth.js", () => ({
  hasRuntimeAvailableProviderAuth: modelAuthMocks.hasRuntimeAvailableProviderAuth,
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfilesMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    authProfilesMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForProviders: authProfilesMocks.externalCliDiscoveryForProviders,
  externalCliDiscoveryForProviderAuth: authProfilesMocks.externalCliDiscoveryForProviderAuth,
  listProfilesForProvider: authProfilesMocks.listProfilesForProvider,
}));

vi.mock("./workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/warm/default-workspace",
}));

vi.mock("./agent-scope-config.js", () => ({
  listAgentIds: () => ["default"],
  resolveAgentDir: () => "/warm/default-agent",
  resolveAgentWorkspaceDir: () => "/warm/default-workspace",
  resolveDefaultAgentId: () => "default",
}));

const { clearCurrentProviderAuthState, hasAuthForModelProvider, warmCurrentProviderAuthState } =
  await import("./model-provider-auth.js");

describe("prepared provider auth state", () => {
  afterEach(() => {
    clearCurrentProviderAuthState();
    vi.clearAllMocks();
  });

  it("hasAuthForModelProvider returns the prepared answer after warm and falls through to compute after clear", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
      { id: "claude", name: "claude", provider: "anthropic" },
    ]);
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockImplementation(
      ({ provider }) => provider === "openai",
    );

    await warmCurrentProviderAuthState(cfg);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Flip the underlying answer; if the prepared map is consulted first,
    // hasAuthForModelProvider returns the cached answers without re-running
    // the compute path.
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(true);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    await expect(hasAuthForModelProvider({ provider: "anthropic", cfg })).resolves.toBe(false);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Clearing the prepared state forces the compute path on the next read.
    clearCurrentProviderAuthState();
    await expect(hasAuthForModelProvider({ provider: "anthropic", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(3);
  });

  it("hasAuthForModelProvider falls through to compute when the caller narrows the auth-discovery scope", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    // Warm with the broad answer: provider has CLI/synthetic auth.
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(true);
    await warmCurrentProviderAuthState(cfg);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    // Flip the underlying compute to false. A narrow-scope caller must NOT
    // pick up the warmed broad answer — gateway models.list with
    // runtimeAuthDiscovery: false maps to both flags false, and the answer
    // must reflect that narrower scope, not the prepared broad answer.
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(false);
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        discoverExternalCliAuth: false,
        allowPluginSyntheticAuth: false,
      }),
    ).resolves.toBe(false);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Broad-scope caller (default flags) still hits the prepared map.
    await expect(hasAuthForModelProvider({ provider: "openai", cfg })).resolves.toBe(true);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);
  });

  it("hasAuthForModelProvider uses the prepared answer for equivalent runtime config clones", async () => {
    const cfg = { gateway: { port: 18789 } } as OpenClawConfig;
    const clonedCfg = structuredClone(cfg);
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(true);
    await warmCurrentProviderAuthState(cfg);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(false);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg: clonedCfg })).resolves.toBe(
      true,
    );
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);
  });

  it("hasAuthForModelProvider falls through to compute when the caller passes a non-default workspaceDir", async () => {
    const cfg = {} as OpenClawConfig;
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { id: "gpt", name: "gpt", provider: "openai" },
    ]);
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(true);
    await warmCurrentProviderAuthState(cfg);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(1);

    // Per-agent picker calls pass an agent-specific workspaceDir that the
    // warmer did not cover; the prepared answer must not leak across
    // workspaces because env/plugin auth resolution depends on workspaceDir.
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(false);
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        workspaceDir: "/different/agent-workspace",
      }),
    ).resolves.toBe(false);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    // Same workspaceDir as the warmer (the default) still hits the prepared map.
    await expect(
      hasAuthForModelProvider({
        provider: "openai",
        cfg,
        workspaceDir: "/warm/default-workspace",
      }),
    ).resolves.toBe(true);
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);
  });

  it("does not publish an older warm after the prepared auth state is cleared", async () => {
    const firstCfg = { gateway: { port: 18789 } } as OpenClawConfig;
    const secondCfg = { gateway: { port: 19001 } } as OpenClawConfig;
    let resolveFirstCatalog: ((catalog: ModelCatalogEntry[]) => void) | undefined;
    let resolveSecondCatalog: ((catalog: ModelCatalogEntry[]) => void) | undefined;
    modelCatalogMocks.loadModelCatalog
      .mockReturnValueOnce(
        new Promise<ModelCatalogEntry[]>((resolve) => {
          resolveFirstCatalog = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ModelCatalogEntry[]>((resolve) => {
          resolveSecondCatalog = resolve;
        }),
      );
    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockImplementation(
      ({ cfg }) => cfg === firstCfg,
    );

    const firstWarm = warmCurrentProviderAuthState(firstCfg);
    await Promise.resolve();
    clearCurrentProviderAuthState();
    const secondWarm = warmCurrentProviderAuthState(secondCfg);

    resolveSecondCatalog?.([{ id: "gpt", name: "gpt", provider: "openai" }]);
    await secondWarm;
    resolveFirstCatalog?.([{ id: "gpt", name: "gpt", provider: "openai" }]);
    await firstWarm;
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);

    modelAuthMocks.hasRuntimeAvailableProviderAuth.mockReturnValue(true);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg: secondCfg })).resolves.toBe(
      false,
    );
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(2);
    await expect(hasAuthForModelProvider({ provider: "openai", cfg: firstCfg })).resolves.toBe(
      true,
    );
    expect(modelAuthMocks.hasRuntimeAvailableProviderAuth).toHaveBeenCalledTimes(3);
  });
});
