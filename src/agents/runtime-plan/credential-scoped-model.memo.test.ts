import { describe, expect, it, vi } from "vitest";
import {
  createPreparedRuntimeModelMaterializer,
  createPreparedRuntimeRouteModelMemo,
} from "./credential-scoped-model.js";
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

function buildMaterializer(params: {
  memo?: ReturnType<typeof createPreparedRuntimeRouteModelMemo>;
  resolveModel: () => Promise<{ model?: typeof routedModel | null; error?: string }>;
}) {
  return createPreparedRuntimeModelMaterializer({
    provider: "openai",
    modelId: "gpt-5.5",
    // Base model deliberately mismatched so materialization must resolve.
    getModel: () => ({ ...routedModel, baseUrl: "https://api.openai.com/v1" }),
    nativeModelOwned: false,
    providerUsesProfileScopedModelMetadata: true,
    ...(params.memo ? { generationRouteModelMemo: params.memo } : {}),
    resolveModel: params.resolveModel,
  });
}

describe("generation route-model memo", () => {
  it("shares one resolution across materializer instances for value-identical plans", async () => {
    const memo = createPreparedRuntimeRouteModelMemo();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    // Two materializers = two runs of the same generation; two fresh plan
    // objects = the per-turn minting that defeats identity-keyed caching.
    const runA = buildMaterializer({ memo, resolveModel });
    const runB = buildMaterializer({ memo, resolveModel });

    await expect(runA.materialize(buildPlan())).resolves.toBe(routedModel);
    await expect(runB.materialize(buildPlan())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct auth profiles as distinct memo entries", async () => {
    const memo = createPreparedRuntimeRouteModelMemo();
    const resolveModel = vi.fn(async () => ({ model: routedModel }));
    const run = buildMaterializer({ memo, resolveModel });

    await run.materialize(buildPlan());
    await run.materialize(buildPlan({ forwardedAuthProfileId: "openai:backup" }));
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("never pins a rejected resolution for the generation", async () => {
    const memo = createPreparedRuntimeRouteModelMemo();
    const resolveModel = vi
      .fn()
      .mockResolvedValueOnce({ error: "transient provider failure" })
      .mockResolvedValue({ model: routedModel });
    const runA = buildMaterializer({ memo, resolveModel });
    const runB = buildMaterializer({ memo, resolveModel });

    await expect(runA.materialize(buildPlan())).rejects.toThrow("transient provider failure");
    await expect(runB.materialize(buildPlan())).resolves.toBe(routedModel);
    expect(resolveModel).toHaveBeenCalledTimes(2);
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
