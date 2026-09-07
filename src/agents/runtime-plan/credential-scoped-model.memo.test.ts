import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPreparedRuntimeModelMaterializer } from "./credential-scoped-model.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

// Fresh object per call, matching prepare-auth minting new plans every turn.
function buildPlan(overrides: Partial<AgentRuntimeAuthPlan> = {}): AgentRuntimeAuthPlan {
  return {
    providerForAuth: "openai",
    authProfileProviderForAuth: "openai",
    forwardedAuthProfileId: "openai:subscription",
    selectedAuthMode: "token",
    modelRoute: {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
      requestTransportOverrides: "none",
    },
    ...overrides,
  };
}

const routedModel = {
  provider: "openai",
  id: "gpt-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

type RouteMemo = Map<string, Promise<typeof routedModel>>;

function buildMaterializer(params: {
  memo?: RouteMemo;
  providerOwnsDynamicModelRefresh?: boolean;
  resolveModel: () => Promise<{ model?: typeof routedModel | null; error?: string }>;
}) {
  return createPreparedRuntimeModelMaterializer({
    provider: "openai",
    modelId: "gpt-5.5",
    // Base model deliberately mismatched so materialization must resolve.
    getModel: () => ({ ...routedModel, baseUrl: "https://api.openai.com/v1" }),
    nativeModelOwned: false,
    providerUsesProfileScopedModelMetadata: true,
    providerOwnsDynamicModelRefresh: params.providerOwnsDynamicModelRefresh,
    ...(params.memo ? { generationRouteModelMemo: params.memo } : {}),
    resolveModel: params.resolveModel,
  });
}

describe("generation route-model memo", () => {
  it("coalesces pending resolution across runs with value-identical plans", async () => {
    const memo: RouteMemo = new Map();
    const pending = createDeferred<{ model: typeof routedModel }>();
    const resolveModel = vi.fn(() => pending.promise);
    const first = buildMaterializer({ memo, resolveModel }).materialize(buildPlan());
    const second = buildMaterializer({ memo, resolveModel }).materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(1);
    pending.resolve({ model: routedModel });
    await expect(Promise.all([first, second])).resolves.toEqual([routedModel, routedModel]);
  });

  it("keeps distinct auth profiles as distinct memo entries", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const run = buildMaterializer({ memo, resolveModel });

    await run.materialize(buildPlan());
    await run.materialize(buildPlan({ forwardedAuthProfileId: "openai:backup" }));
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("keeps delimiter-containing route identities as distinct memo entries", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const run = buildMaterializer({ memo, resolveModel });

    await run.materialize(
      buildPlan({
        forwardedAuthProfileId: "openai:subscription\u0001token",
        selectedAuthMode: undefined,
      }),
    );
    await run.materialize(
      buildPlan({
        forwardedAuthProfileId: "openai:subscription",
        selectedAuthMode: "token",
      }),
    );
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("preserves provider-owned dynamic-model refreshes across turns", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const runA = buildMaterializer({ memo, resolveModel, providerOwnsDynamicModelRefresh: true });
    const runB = buildMaterializer({ memo, resolveModel, providerOwnsDynamicModelRefresh: true });

    await runA.materialize(buildPlan());
    await runB.materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("never pins a rejected resolution for the generation", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi
      .fn()
      .mockResolvedValueOnce({ error: "transient provider failure" })
      .mockResolvedValue({ model: routedModel });
    const runA = buildMaterializer({ memo, resolveModel });
    const runB = buildMaterializer({ memo, resolveModel });

    await expect(runA.materialize(buildPlan())).rejects.toThrow("transient provider failure");
    expect(memo.size).toBe(0);
    await expect(runB.materialize(buildPlan())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("covers route-less plans so non-OpenAI providers share resolutions too", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const runA = buildMaterializer({ memo, resolveModel });
    const runB = buildMaterializer({ memo, resolveModel });
    // Generic (route-less) plans with a forwarded profile force resolution
    // every turn; the memo must cover them or Anthropic/Google agents pay
    // the full resolve on every message.
    const routeless = () => buildPlan({ modelRoute: undefined });

    await expect(runA.materialize(routeless())).resolves.toBe(routedModel);
    await expect(runB.materialize(routeless())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps each run's base model private (native ownership %s)",
    async (nativeModelOwned) => {
      const memo: RouteMemo = new Map();
      const resolveModel = vi.fn(async () => ({ model: routedModel }));
      if (nativeModelOwned) {
        await buildMaterializer({ memo, resolveModel }).materialize(buildPlan());
      }
      const buildBaseReturningMaterializer = (base: typeof routedModel) =>
        createPreparedRuntimeModelMaterializer({
          provider: "openai",
          modelId: "gpt-5.5",
          getModel: () => base,
          nativeModelOwned,
          providerUsesProfileScopedModelMetadata: nativeModelOwned,
          generationRouteModelMemo: memo,
          resolveModel,
        });
      const baseA = { ...routedModel };
      const baseB = { ...routedModel };
      const plan = () =>
        nativeModelOwned
          ? buildPlan()
          : buildPlan({ forwardedAuthProfileId: undefined, selectedAuthMode: undefined });
      await expect(buildBaseReturningMaterializer(baseA).materialize(plan())).resolves.toBe(baseA);
      await expect(buildBaseReturningMaterializer(baseB).materialize(plan())).resolves.toBe(baseB);
      expect(resolveModel).toHaveBeenCalledTimes(nativeModelOwned ? 1 : 0);
      expect(memo.size).toBe(nativeModelOwned ? 1 : 0);
    },
  );

  it("retains 64 keys and evicts the oldest when a new key is resolved", async () => {
    const memo: RouteMemo = new Map();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const turn = (profile: number) =>
      buildMaterializer({ memo, resolveModel }).materialize(
        buildPlan({ forwardedAuthProfileId: `openai:profile-${profile}` }),
      );
    for (let profile = 0; profile < 64; profile += 1) {
      await turn(profile);
    }
    expect(memo.size).toBe(64);
    await turn(0);
    await turn(63);
    expect(resolveModel).toHaveBeenCalledTimes(64);
    await turn(64);
    expect(memo.size).toBe(64);
    await turn(0);
    await turn(64);
    expect(resolveModel).toHaveBeenCalledTimes(66);
    expect(memo.size).toBe(64);
  });

  it("does not let an evicted promise's late rejection remove its replacement", async () => {
    const memo: RouteMemo = new Map();
    const pending = createDeferred<{ model: typeof routedModel }>();
    const resolveModel = vi
      .fn<() => Promise<{ model: typeof routedModel }>>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ model: routedModel });
    const turn = (profile: number) =>
      buildMaterializer({ memo, resolveModel }).materialize(
        buildPlan({ forwardedAuthProfileId: `openai:profile-${profile}` }),
      );
    const first = expect(turn(0)).rejects.toThrow("retired resolution failed");
    for (let profile = 1; profile <= 64; profile += 1) {
      await turn(profile);
    }
    const replacement = { ...routedModel };
    resolveModel.mockResolvedValueOnce({ model: replacement });
    await expect(turn(0)).resolves.toBe(replacement);
    pending.reject(new Error("retired resolution failed"));
    await first;
    expect(memo.size).toBe(64);
    await expect(turn(0)).resolves.toBe(replacement);
    expect(resolveModel).toHaveBeenCalledTimes(66);
  });

  it("keeps run-local behavior unchanged when no memo is provided", async () => {
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const runA = buildMaterializer({ resolveModel });
    const runB = buildMaterializer({ resolveModel });

    await runA.materialize(buildPlan());
    await runB.materialize(buildPlan());
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });
});
