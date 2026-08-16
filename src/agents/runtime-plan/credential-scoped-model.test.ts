import { describe, expect, it, vi } from "vitest";
import { createPreparedRuntimeModelMaterializer } from "./credential-scoped-model.js";
import { readPreparedRuntimeModelMaterializationReason } from "./materialize-model.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

const plan: AgentRuntimeAuthPlan = {
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
};

const matchingModel = {
  provider: "openai",
  id: "gpt-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

describe("createPreparedRuntimeModelMaterializer", () => {
  it("caches a typed rejection for the same prepared plan", async () => {
    const resolveModel = vi.fn(async () => ({
      error:
        "Unable to refresh SecretRef token=sk-secret-token for https://chatgpt.com/backend-api/codex profile openai:subscription",
    }));
    const { materialize } = createPreparedRuntimeModelMaterializer({
      provider: "openai",
      modelId: "gpt-5.5",
      getModel: () => matchingModel,
      nativeModelOwned: false,
      providerUsesProfileScopedModelMetadata: false,
      resolveModel,
    });

    const first = materialize(plan);
    const second = materialize(plan);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/SecretRef token=sk-secret-token/u);
    await expect(second).rejects.toSatisfy((error) => {
      const reason = readPreparedRuntimeModelMaterializationReason(error);
      expect(reason).toMatchObject({
        code: "resolved-model-missing",
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      });
      expect(JSON.stringify(reason)).not.toMatch(
        /https?:\/\/|openai:subscription|sk-secret-token/u,
      );
      return true;
    });
    expect(resolveModel).toHaveBeenCalledOnce();
  });

  it("does not let a cached failure reorder a later distinct plan", async () => {
    const otherPlan: AgentRuntimeAuthPlan = {
      ...plan,
      forwardedAuthProfileId: "openai:backup",
      modelRoute: {
        ...plan.modelRoute!,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
      },
    };
    const resolveModel = vi.fn(async (request: { authProfileId?: string }) => {
      if (request.authProfileId === "openai:subscription") {
        return { error: "Unable to refresh SecretRef token=sk-secret-token" };
      }
      return {
        model: {
          provider: "openai",
          id: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      };
    });
    const { materialize } = createPreparedRuntimeModelMaterializer({
      provider: "openai",
      modelId: "gpt-5.5",
      getModel: () => matchingModel,
      nativeModelOwned: false,
      providerUsesProfileScopedModelMetadata: false,
      resolveModel,
    });

    await expect(materialize(plan)).rejects.toSatisfy((error) => {
      expect(readPreparedRuntimeModelMaterializationReason(error)?.code).toBe(
        "resolved-model-missing",
      );
      return true;
    });
    await expect(materialize(otherPlan)).resolves.toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it("leaves native-owned models on the caller tuple", async () => {
    const resolveModel = vi.fn();
    const { materialize } = createPreparedRuntimeModelMaterializer({
      provider: "openai",
      modelId: "gpt-5.5",
      getModel: () => matchingModel,
      nativeModelOwned: true,
      providerUsesProfileScopedModelMetadata: false,
      resolveModel,
    });

    await expect(materialize(plan)).resolves.toBe(matchingModel);
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
