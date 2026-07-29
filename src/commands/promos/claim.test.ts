import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  fetchClawHubPromotion: vi.fn(),
  hasAvailableAuthForProvider: vi.fn(),
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
  resolveManifestProviderAuthChoice: vi.fn(),
  resolveProviderInstallCatalogEntry: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  promptYesNo: vi.fn(),
  enablePluginInConfig: vi.fn(),
  repairCodex: vi.fn(),
  repairCopilot: vi.fn(),
  recordPromotionClaim: vi.fn(),
  markPromotionSlugsNotified: vi.fn(),
}));

vi.mock("../../infra/promotions-feed.js", () => ({
  recordPromotionClaim: mocks.recordPromotionClaim,
  markPromotionSlugsNotified: mocks.markPromotionSlugsNotified,
}));

vi.mock("../../infra/clawhub.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/clawhub.js")>("../../infra/clawhub.js");
  return {
    ...actual,
    fetchClawHubPromotion: mocks.fetchClawHubPromotion,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: mocks.hasAvailableAuthForProvider,
}));

vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: mocks.applyAuthChoiceLoadedPluginProvider,
}));

vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: mocks.resolveManifestProviderAuthChoice,
}));

vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: mocks.resolveProviderInstallCatalogEntry,
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../../plugins/enable.js", () => ({
  enablePluginInConfig: mocks.enablePluginInConfig,
}));

vi.mock("../codex-runtime-plugin-install.js", () => ({
  repairCodexRuntimePluginInstallForModelSelection: mocks.repairCodex,
}));

vi.mock("../copilot-runtime-plugin-install.js", () => ({
  repairCopilotRuntimePluginInstallForModelSelection: mocks.repairCopilot,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: vi.fn(() => ({})),
}));

const { ClawHubRequestError } = await import("../../infra/clawhub.js");
const { promosClaimCommand } = await import("./claim.js");

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
}

const now = Date.now();

function makePromotion(overrides: Record<string, unknown> = {}) {
  return {
    slug: "spring-models",
    title: "Free Example models",
    blurb: "A limited-time offer.",
    status: "active",
    active: true,
    startsAt: now - 1_000,
    endsAt: now + 86_400_000,
    provider: "openrouter",
    authChoiceId: "openrouter-api-key",
    models: [
      { modelRef: "openrouter/example/model-alpha", alias: "model-alpha", suggestedDefault: true },
    ],
    signupUrl: "https://signup.example.com",
    ...overrides,
  };
}

function makeSnapshot(config: Record<string, unknown> = {}) {
  return {
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash-1",
    issues: [],
    config,
    sourceConfig: config,
    runtimeConfig: config,
  };
}

const authChoice = {
  pluginId: "openrouter",
  providerId: "openrouter",
  methodId: "api-key",
  choiceId: "openrouter-api-key",
  choiceLabel: "OpenRouter API key",
  optionKey: "openrouterApiKey",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot());
  mocks.replaceConfigFile.mockResolvedValue(undefined);
  mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
  mocks.resolveManifestProviderAuthChoice.mockReturnValue(authChoice);
  mocks.resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
  mocks.loadManifestMetadataSnapshot.mockReturnValue({
    manifestRegistry: {
      plugins: [{ id: "openrouter", packageName: "@openclaw/openrouter-provider" }],
    },
  });
  mocks.promptYesNo.mockResolvedValue(false);
  mocks.enablePluginInConfig.mockImplementation((cfg: unknown, pluginId: string) => ({
    config: cfg,
    enabled: true,
    pluginId,
  }));
  mocks.fetchClawHubPromotion.mockResolvedValue(makePromotion());
  mocks.repairCodex.mockResolvedValue({ warnings: [] });
  mocks.repairCopilot.mockResolvedValue({ warnings: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("promosClaimCommand", () => {
  it("registers promo models with aliases without changing the default", async () => {
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"]).toEqual({
      alias: "model-alpha",
    });
    expect(next.agents.defaults.model).toBeUndefined();
    expect(mocks.applyAuthChoiceLoadedPluginProvider).not.toHaveBeenCalled();
    // Provenance powers the `promo` tags in `models list` and future cleanup.
    expect(mocks.recordPromotionClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "spring-models",
        provider: "openrouter",
        modelKeys: ["openrouter/example/model-alpha"],
      }),
    );
    expect(mocks.markPromotionSlugsNotified).toHaveBeenCalledWith(["spring-models"]);
  });

  it("sets the suggested model as default with --set-default", async () => {
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { setDefault: true }, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.model.primary).toBe("openrouter/example/model-alpha");
    // Default changes must run the same runtime plugin repair as `models set`.
    expect(mocks.repairCodex).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openrouter/example/model-alpha" }),
    );
    expect(mocks.repairCopilot).toHaveBeenCalled();
  });

  it("skips aliases outside the models-aliases contract but still registers the model", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({
        models: [{ modelRef: "openrouter/example/model-alpha", alias: "bad alias [31m" }],
      }),
    );
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"]).toEqual({});
  });

  it("keeps an existing alias owner and reports the skip", async () => {
    const existing = {
      agents: {
        defaults: {
          models: { "openrouter/other/model": { alias: "model-alpha" } },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot(existing));
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"].alias).toBeUndefined();
    expect(next.agents.defaults.models["openrouter/other/model"].alias).toBe("model-alpha");
  });

  it("runs the provider auth choice when no credentials exist", async () => {
    // An explicit --api-key skips the reuse pre-check entirely; the only
    // hasAvailableAuthForProvider call is the post-apply revalidation.
    mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: { plugins: { entries: { openrouter: { enabled: true } } } },
    });
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { apiKey: "sk-test" }, runtime);

    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openrouter-api-key",
        setDefaultModel: false,
        opts: { openrouterApiKey: "sk-test" },
      }),
    );
    // Auth config write plus the model registration write.
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
  });

  it("runs the auth flow for an explicit --api-key even when other auth exists", async () => {
    // hasAvailableAuthForProvider stays true; the explicit key must not be ignored.
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { apiKey: "sk-explicit" }, runtime);

    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { openrouterApiKey: "sk-explicit" } }),
    );
  });

  it("aborts when the auth flow asks for retry instead of completing", async () => {
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: {},
      retrySelection: true,
    });

    await expect(
      promosClaimCommand("spring-models", { apiKey: "sk-test" }, makeRuntime()),
    ).rejects.toThrow(/not completed/);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("aborts when auth is still unavailable after the flow returns", async () => {
    // Both the pre-check and the post-apply revalidation report no usable auth
    // (e.g. the provider plugin was disabled and the flow returned unchanged).
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });

    await expect(
      promosClaimCommand("spring-models", { apiKey: "sk-test" }, makeRuntime()),
    ).rejects.toThrow(/not completed/);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails when the promotion's auth choice is unknown locally", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntry.mockReturnValue(undefined);

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /Update OpenClaw/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails when the auth choice belongs to a different provider", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue({
      ...authChoice,
      providerId: "another-provider",
    });

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /refusing to configure/,
    );
  });

  it("accepts a declared plugin package owned by the resolved auth choice", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ pluginNames: ["@openclaw/openrouter-provider"] }),
    );

    await promosClaimCommand("spring-models", {}, makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared plugin package not owned by the resolved auth choice", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ pluginNames: ["@openclaw/other-provider"] }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /requires plugin package/,
    );
    expect(mocks.hasAvailableAuthForProvider).not.toHaveBeenCalled();
    expect(mocks.enablePluginInConfig).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("refuses models outside the promotion's provider", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ models: [{ modelRef: "sneaky-provider/model" }] }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /outside its provider/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("reports ended promotions with their end date", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: false, endsAt: now - 86_400_000 }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(/ended/);
  });

  it("enforces the window even when the payload claims active", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: true, endsAt: now - 60_000 }),
    );
    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(/ended/);

    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: true, startsAt: now + 60_000, endsAt: now + 86_400_000 }),
    );
    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /not live/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("rechecks the window after authentication before updating model config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: true, endsAt: now + 60_000 }),
    );
    mocks.hasAvailableAuthForProvider.mockImplementation(async () => {
      vi.setSystemTime(now + 120_000);
      return true;
    });

    try {
      await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(/ended/);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a promotion withdrawn after provider authentication", async () => {
    const initial = makePromotion();
    mocks.fetchClawHubPromotion
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, active: false });
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });

    await expect(
      promosClaimCommand("spring-models", { apiKey: "sk-test" }, makeRuntime()),
    ).rejects.toThrow(/not live/);

    expect(mocks.fetchClawHubPromotion).toHaveBeenCalledTimes(2);
    // Provider auth completed before the withdrawal was observed, but no
    // promotion model/default/provenance mutation may follow it.
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.recordPromotionClaim).not.toHaveBeenCalled();
  });

  it("refuses actionable promotion changes after authentication", async () => {
    const initial = makePromotion();
    mocks.fetchClawHubPromotion.mockResolvedValueOnce(initial).mockResolvedValueOnce(
      makePromotion({
        models: [{ modelRef: "openrouter/example/model-beta", suggestedDefault: true }],
      }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /changed while the claim was in progress/,
    );

    expect(mocks.fetchClawHubPromotion).toHaveBeenCalledTimes(2);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.recordPromotionClaim).not.toHaveBeenCalled();
  });

  it("runs the install path when the auth choice is not installed, even with existing auth", async () => {
    // Existing env credentials must not shortcut past a required plugin install.
    mocks.resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntry.mockReturnValue({
      ...authChoice,
      installSource: {
        npm: { packageName: "@openclaw/openrouter-provider" },
      },
    });
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ pluginNames: ["@openclaw/openrouter-provider"] }),
    );
    mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });

    await promosClaimCommand("spring-models", {}, makeRuntime());

    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({ authChoice: "openrouter-api-key" }),
    );
  });

  it("refuses to claim when the provider plugin is blocked by policy", async () => {
    mocks.enablePluginInConfig.mockImplementation((cfg: unknown, pluginId: string) => ({
      config: cfg,
      enabled: false,
      pluginId,
      reason: "denylisted",
    }));

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /plugin policy/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("maps 404 responses to a friendly not-found error", async () => {
    const requestError = new ClawHubRequestError({
      path: "/api/v1/promotions/nope",
      status: 404,
      body: "not found",
    });
    mocks.fetchClawHubPromotion.mockRejectedValue(requestError);

    await expect(promosClaimCommand("nope", {}, makeRuntime())).rejects.toMatchObject({
      message: expect.stringMatching(/not found or is not live/),
      cause: requestError,
    });
  });
});
