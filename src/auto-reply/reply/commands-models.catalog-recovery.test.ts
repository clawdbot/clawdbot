import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const catalogMocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadPublishedOwner: vi.fn(),
  authStore: { version: 1, profiles: {} } as AuthProfileStore,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: catalogMocks.loadSnapshot,
  loadPreparedModelCatalogOwnerSnapshot: async (...args: unknown[]) => {
    const owner = {
      modelCatalog: await catalogMocks.loadSnapshot(...args),
      authModes: {},
    };
    setPreparedModelRuntimeAuthStore(owner, catalogMocks.authStore);
    return owner;
  },
  loadPublishedPreparedModelCatalogOwnerSnapshot: catalogMocks.loadPublishedOwner,
}));

const { buildPreparedModelsProviderData } = await import("./commands-models.js");

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;

const replacementCfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
} as OpenClawConfig;

afterEach(() => {
  vi.clearAllMocks();
  catalogMocks.authStore = { version: 1, profiles: {} };
});

describe("/models browse catalog recovery", () => {
  it.each([false, true])(
    "projects prepared external OAuth with explicit exclusion=%s",
    async (excluded) => {
      catalogMocks.authStore = {
        version: 1,
        profiles: {
          "openai:external": {
            type: "oauth",
            provider: "openai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
          },
        },
        runtimeExternalProfileIds: ["openai:external"],
        ...(excluded ? { order: { openai: [] } } : {}),
      };
      const subscription = {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      };
      catalogMocks.loadSnapshot.mockResolvedValueOnce({
        entries: [subscription],
        routeVariants: [subscription],
      });

      const data = await buildPreparedModelsProviderData(staleCfg);

      expect(data.providers.includes("openai")).toBe(!excluded);
      if (!excluded) {
        expect(data.modelCatalog.find((entry) => entry.provider === "openai")).toMatchObject({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        });
      }
    },
  );

  it("returns the exact-config snapshot when the prepared owner matches", async () => {
    catalogMocks.loadSnapshot.mockResolvedValueOnce({
      entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" }],
      routeVariants: [],
    });

    const data = await buildPreparedModelsProviderData(staleCfg);

    expect(data.byProvider.get("anthropic")).toEqual(new Set(["claude-opus-4-5"]));
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });

  it("rebuilds the whole browse result from the replacement owner's config, not the stale cfg", async () => {
    catalogMocks.loadSnapshot
      .mockRejectedValueOnce(new PreparedModelCatalogConfigReplacedError("/tmp/agent-dir"))
      .mockResolvedValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
        routeVariants: [],
      });
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ config: replacementCfg });

    const data = await buildPreparedModelsProviderData(staleCfg);

    // The recovered menu reflects the replacement generation end-to-end: its catalog entry
    // and its resolved default both come from replacementCfg, never staleCfg's stale anthropic
    // default that the new config already removed.
    expect(data.resolvedDefault).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(data.byProvider.get("anthropic")).toBeUndefined();
    expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.6-luna"]));
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(catalogMocks.loadSnapshot.mock.calls[1]?.[0]).toMatchObject({ config: replacementCfg });
    expect(catalogMocks.loadSnapshot.mock.calls.map(([params]) => params.readOnly)).toEqual([
      true,
      true,
    ]);
  });

  it("lets a second owner replacement escape", async () => {
    const first = new PreparedModelCatalogConfigReplacedError("/tmp/agent-a");
    const second = new PreparedModelCatalogConfigReplacedError("/tmp/agent-b");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ config: replacementCfg });

    await expect(buildPreparedModelsProviderData(staleCfg)).rejects.toBe(second);
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("boom");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(error);

    await expect(buildPreparedModelsProviderData(staleCfg)).rejects.toBe(error);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });
});
