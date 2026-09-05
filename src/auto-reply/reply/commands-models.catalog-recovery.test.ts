import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import * as providerAuth from "../../agents/model-provider-auth.js";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const catalogMocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadPublishedOwner: vi.fn(),
  authStore: { version: 1, profiles: {} } as AuthProfileStore,
  isCurrent: (): boolean => true,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => {
  const loadOwner = async (...args: unknown[]) => {
    const owner = {
      modelCatalog: await catalogMocks.loadSnapshot(...args),
      authModes: {},
      isCurrent: catalogMocks.isCurrent,
    };
    setPreparedModelRuntimeAuthStore(owner, catalogMocks.authStore);
    return owner;
  };
  return {
    loadPreparedModelCatalogSnapshot: catalogMocks.loadSnapshot,
    loadPreparedModelCatalogOwnerSnapshot: loadOwner,
    withPreparedModelCatalogOwner: async (
      params: unknown,
      read: (owner: Awaited<ReturnType<typeof loadOwner>>) => unknown,
    ) => read(await loadOwner(params)),
    loadPublishedPreparedModelCatalogOwnerSnapshot: catalogMocks.loadPublishedOwner,
  };
});

const { buildPreparedModelsProviderData, resolveModelsCommandReply } =
  await import("./commands-models.js");

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;

const replacementCfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
} as OpenClawConfig;

afterEach(() => {
  catalogMocks.loadSnapshot.mockReset();
  catalogMocks.loadPublishedOwner.mockReset();
  vi.useRealTimers();
  catalogMocks.authStore = { version: 1, profiles: {} };
  catalogMocks.isCurrent = () => true;
  vi.restoreAllMocks();
});

describe("/models browse catalog recovery", () => {
  it.each([
    { view: "default", delayMs: 0 },
    { view: "all", delayMs: 1_000 },
    { view: "default", delayMs: 1_000 },
  ] as const)(
    "recovers supersession during $view auth projection within its deadline (delay=$delayMs)",
    async ({ view, delayMs }) => {
      vi.useFakeTimers();
      let current = true;
      catalogMocks.isCurrent = () => current;
      const evaluating = createDeferred();
      const resumeAuth = createDeferred();
      const evaluateModelAuth = vi.fn(async () => ({
        availability: true as const,
        routeResolution: null,
      }));
      evaluateModelAuth.mockImplementationOnce(async () => {
        evaluating.resolve();
        await resumeAuth.promise;
        return { availability: true, routeResolution: null };
      });
      vi.spyOn(providerAuth, "createProviderAuthChecker").mockReturnValue(
        Object.assign(async () => true, { evaluateModelAuth }),
      );
      catalogMocks.loadSnapshot
        .mockResolvedValueOnce({
          entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Stale model" }],
          routeVariants: [],
        })
        .mockResolvedValueOnce({
          entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "Current model" }],
          routeVariants: [],
        });
      catalogMocks.loadPublishedOwner.mockImplementationOnce(async () => {
        catalogMocks.isCurrent = () => true;
        return { config: replacementCfg };
      });

      let settled = false;
      const result = buildPreparedModelsProviderData(staleCfg, undefined, { view }).then((data) => {
        settled = true;
        return data;
      });
      await evaluating.promise;
      current = false;
      const timedOut = view === "default" && delayMs > 750;
      if (delayMs) {
        await vi.advanceTimersByTimeAsync(delayMs);
        expect(settled).toBe(timedOut);
      }
      resumeAuth.resolve();
      const data = await result;
      await vi.advanceTimersByTimeAsync(0);

      expect(data.resolvedDefault).toEqual(
        timedOut
          ? { provider: "anthropic", model: "claude-opus-4-5" }
          : { provider: "openai", model: "gpt-5.6-luna" },
      );
      expect(data.providers).toEqual([timedOut ? "anthropic" : "openai"]);
      expect(data.modelNames.has("anthropic/claude-opus-4-5")).toBe(false);
      expect(data.modelNames.get("openai/gpt-5.6-luna")).toBe(
        timedOut ? undefined : "Current model",
      );
      expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(timedOut ? 0 : 1);
    },
  );

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

  it("carries the command-selected directory into current-owner recovery", async () => {
    catalogMocks.loadSnapshot
      .mockRejectedValueOnce(new PreparedModelCatalogConfigReplacedError("/tmp/selected-agent"))
      .mockResolvedValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "Current Luna" }],
        routeVariants: [],
      });
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({
      agentDir: "/tmp/current-agent",
      config: replacementCfg,
    });

    await resolveModelsCommandReply({
      cfg: staleCfg,
      commandBodyNormalized: "/models",
      agentId: "worker",
      agentDir: "/tmp/selected-agent",
      workspaceDir: "/tmp/selected-workspace",
    });

    expect(catalogMocks.loadSnapshot.mock.calls[0]?.[0]).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/selected-agent",
      config: staleCfg,
      workspaceDir: "/tmp/selected-workspace",
    });
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledWith({
      agentId: "worker",
      readOnly: true,
      workspaceDir: "/tmp/selected-workspace",
    });
    expect(catalogMocks.loadSnapshot.mock.calls[1]?.[0]).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/current-agent",
      config: replacementCfg,
      workspaceDir: "/tmp/selected-workspace",
    });
  });

  it.each([
    ["config replacement", () => new PreparedModelCatalogConfigReplacedError("/tmp/agent-dir")],
    [
      "publication supersession",
      () => new PreparedModelRuntimePublicationSupersededError("superseded"),
    ],
  ])("rebuilds the whole browse result after %s", async (_label, createError) => {
    catalogMocks.loadSnapshot.mockRejectedValueOnce(createError()).mockResolvedValueOnce({
      entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      routeVariants: [],
    });
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ config: replacementCfg });

    const data = await buildPreparedModelsProviderData(staleCfg);

    expect(data.resolvedDefault).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(data.byProvider.get("anthropic")).toBeUndefined();
    expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.6-luna"]));
    expect(data.modelNames.get("openai/gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(data.runtimeChoicesByProvider?.has("openai")).toBe(true);
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(catalogMocks.loadSnapshot.mock.calls[1]?.[0]).toMatchObject({ config: replacementCfg });
  });

  it("uses the current agent directory and selected workspace across multiple reloads", async () => {
    const intermediateCfg = {
      agents: {
        defaults: { model: { primary: "google/gemini-3.1-pro" } },
        list: [
          {
            id: "worker",
            default: true,
            agentDir: "/tmp/intermediate-agent",
            workspace: "/tmp/intermediate-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const currentCfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        list: [
          {
            id: "worker",
            default: true,
            agentDir: "/tmp/current-agent",
            workspace: "/tmp/current-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    catalogMocks.loadSnapshot
      .mockRejectedValueOnce(new PreparedModelCatalogConfigReplacedError("/tmp/stale-agent"))
      .mockRejectedValueOnce(new PreparedModelRuntimePublicationSupersededError("superseded again"))
      .mockResolvedValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "Current Luna" }],
        routeVariants: [],
      });
    catalogMocks.loadPublishedOwner
      .mockResolvedValueOnce({ agentDir: "/tmp/intermediate-agent", config: intermediateCfg })
      .mockResolvedValueOnce({ agentDir: "/tmp/current-agent", config: currentCfg });

    const reply = await resolveModelsCommandReply({
      cfg: staleCfg,
      commandBodyNormalized: "/models",
      agentId: "worker",
      agentDir: "/tmp/selected-agent",
      workspaceDir: "/tmp/selected-workspace",
    });

    expect(reply?.text).toContain("openai");
    expect(reply?.text).not.toContain("anthropic");
    expect(reply?.text).not.toContain("google");
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(2);
    for (const [params] of catalogMocks.loadPublishedOwner.mock.calls) {
      expect(params).toMatchObject({
        agentId: "worker",
        readOnly: true,
        workspaceDir: "/tmp/selected-workspace",
      });
      expect(params).not.toHaveProperty("config");
      expect(params).not.toHaveProperty("agentDir");
    }
    expect(catalogMocks.loadSnapshot.mock.calls[0]?.[0]).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/selected-agent",
      config: staleCfg,
      workspaceDir: "/tmp/selected-workspace",
    });
    expect(catalogMocks.loadSnapshot.mock.calls[1]?.[0]).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/intermediate-agent",
      config: intermediateCfg,
      workspaceDir: "/tmp/selected-workspace",
    });
    expect(catalogMocks.loadSnapshot.mock.calls[2]?.[0]).toMatchObject({
      agentId: "worker",
      agentDir: "/tmp/current-agent",
      config: currentCfg,
      workspaceDir: "/tmp/selected-workspace",
    });
  });

  it("uses one browse deadline across repeated owner replacements", async () => {
    vi.useFakeTimers();
    const intermediateCfg = {
      agents: { defaults: { model: { primary: "google/gemini-3.1-pro" } } },
    } as OpenClawConfig;
    const currentCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
    } as OpenClawConfig;
    const rejectAfter = (delayMs: number, error: Error) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(error), delayMs);
      });
    catalogMocks.loadSnapshot
      .mockImplementationOnce(() =>
        rejectAfter(300, new PreparedModelCatalogConfigReplacedError("/tmp/stale-agent")),
      )
      .mockImplementationOnce(() =>
        rejectAfter(300, new PreparedModelRuntimePublicationSupersededError("superseded again")),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    catalogMocks.loadPublishedOwner
      .mockResolvedValueOnce({ config: intermediateCfg })
      .mockResolvedValueOnce({ config: currentCfg });

    const resultPromise = buildPreparedModelsProviderData(staleCfg);
    const result = expect(resultPromise).resolves.toMatchObject({
      resolvedDefault: { provider: "openai", model: "gpt-5.6-luna" },
      providers: ["openai"],
    });
    await vi.advanceTimersByTimeAsync(750);
    await result;
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(2);
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(3);
  });

  it("keeps explicit full-catalog recovery unbounded across late supersession", async () => {
    vi.useFakeTimers();
    catalogMocks.loadSnapshot
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new PreparedModelRuntimePublicationSupersededError("late supersession")),
              1_000,
            );
          }),
      )
      .mockResolvedValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "Current Luna" }],
        routeVariants: [],
      });
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ config: replacementCfg });

    const resultPromise = buildPreparedModelsProviderData(staleCfg, undefined, { view: "all" });
    const result = expect(resultPromise).resolves.toMatchObject({
      resolvedDefault: { provider: "openai", model: "gpt-5.6-luna" },
      providers: ["openai"],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledOnce();
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("bounds current-owner reacquisition by the original browse deadline", async () => {
    vi.useFakeTimers();
    const fallbackCfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "openai/gpt-configured": { alias: "configured" },
          },
        },
      },
    } as OpenClawConfig;
    catalogMocks.loadSnapshot.mockImplementationOnce(() => new Promise(() => {}));

    const ordinaryTimeoutPromise = buildPreparedModelsProviderData(fallbackCfg);
    await vi.advanceTimersByTimeAsync(750);
    const ordinaryTimeout = await ordinaryTimeoutPromise;
    expect(ordinaryTimeout.byProvider.get("openai")).toEqual(new Set(["gpt-configured"]));

    catalogMocks.loadSnapshot.mockReset();
    catalogMocks.loadPublishedOwner.mockReset();
    catalogMocks.loadSnapshot.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new PreparedModelCatalogConfigReplacedError("/tmp/stale-agent")),
            300,
          );
        }),
    );
    catalogMocks.loadPublishedOwner.mockImplementationOnce(() => new Promise(() => {}));

    const resultPromise = buildPreparedModelsProviderData(fallbackCfg);
    await vi.advanceTimersByTimeAsync(750);
    const reacquisitionTimeout = await resultPromise;

    expect(reacquisitionTimeout).toEqual(ordinaryTimeout);
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("boom");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(error);

    await expect(buildPreparedModelsProviderData(staleCfg)).rejects.toBe(error);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });
});
