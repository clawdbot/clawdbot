import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { materializePreparedRuntimeModel } from "./materialize-model.js";
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

describe("materializePreparedRuntimeModel", () => {
  it("reuses a model that already matches the prepared route", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const resolveModel = vi.fn();

    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        model,
        resolveModel,
      }),
    ).resolves.toBe(model);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("re-resolves matching route metadata when the auth profile changes", async () => {
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const rematerialized = { ...model, name: "backup-profile-model" };
    const resolveModel = vi.fn(async () => ({ model: rematerialized }));

    await expect(
      materializePreparedRuntimeModel({
        plan: { ...plan, forwardedAuthProfileId: "openai:backup" },
        provider: "openai",
        modelId: "gpt-5.5",
        model,
        forceResolve: true,
        resolveModel,
      }),
    ).resolves.toBe(rematerialized);
    expect(resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:backup" }),
    );
  });

  it("re-resolves route-less profile-scoped model metadata", async () => {
    const model = {
      provider: "clawrouter",
      id: "private-model",
      api: "anthropic-messages",
      baseUrl: "https://router.example.test",
    };
    const rematerialized = { ...model, name: "backup-profile-model" };
    const resolveModel = vi.fn(async () => ({ model: rematerialized }));

    await expect(
      materializePreparedRuntimeModel({
        plan: {
          providerForAuth: "clawrouter",
          authProfileProviderForAuth: "clawrouter",
          modelId: "private-model",
          forwardedAuthProfileId: "clawrouter:backup",
          selectedAuthMode: "api-key",
        },
        provider: "clawrouter",
        modelId: "private-model",
        config: {} as OpenClawConfig,
        model,
        forceResolve: true,
        resolveModel,
      }),
    ).resolves.toBe(rematerialized);
    expect(resolveModel).toHaveBeenCalledWith({
      config: {},
      authProfileId: "clawrouter:backup",
      authProfileMode: "api_key",
    });
  });

  it("projects the selected route and exact auth mode before resolving", async () => {
    const resolved = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const resolveModel = vi.fn(async () => ({ model: resolved }));

    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        config: { models: { providers: {} } } as OpenClawConfig,
        model: {
          provider: "openai",
          id: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        resolveModel,
      }),
    ).resolves.toBe(resolved);
    expect(resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:subscription",
        authProfileMode: "token",
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              openai: expect.objectContaining({
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("rejects provider metadata that uses a different official adapter", async () => {
    const platformPlan: AgentRuntimeAuthPlan = {
      ...plan,
      forwardedAuthProfileId: "openai:key",
      selectedAuthMode: "api_key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4-nano",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    };
    const model = {
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-completions",
      baseUrl: "https://api.openai.com",
    };
    const resolveModel = vi.fn();

    await expect(
      materializePreparedRuntimeModel({
        plan: platformPlan,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        model,
        rejectMismatchedModel: true,
        resolveModel,
      }),
    ).rejects.toThrow("does not match its prepared api-key route");
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("projects an authored Completions route without reusing Responses metadata", async () => {
    const completionsPlan: AgentRuntimeAuthPlan = {
      ...plan,
      forwardedAuthProfileId: "openai:key",
      selectedAuthMode: "api_key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    };
    const resolved = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    };
    const resolveModel = vi.fn(async () => ({ model: resolved }));

    await expect(
      materializePreparedRuntimeModel({
        plan: completionsPlan,
        provider: "openai",
        modelId: "gpt-5.5",
        config: { models: { providers: {} } } as OpenClawConfig,
        model: {
          provider: "openai",
          id: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        resolveModel,
      }),
    ).resolves.toBe(resolved);
    expect(resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:key",
        authProfileMode: "api_key",
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              openai: expect.objectContaining({
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("accepts the canonical model id for the shipped GPT-5.4 Codex alias", async () => {
    const aliasPlan: AgentRuntimeAuthPlan = {
      ...plan,
      modelRoute: {
        ...plan.modelRoute!,
        modelId: "gpt-5.4-codex",
      },
    };
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const resolveModel = vi.fn();

    await expect(
      materializePreparedRuntimeModel({
        plan: aliasPlan,
        provider: "openai",
        modelId: "gpt-5.4-codex",
        model,
        resolveModel,
      }),
    ).resolves.toBe(model);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("does not reuse another model that shares the prepared transport", async () => {
    const resolved = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const resolveModel = vi.fn(async () => ({ model: resolved }));

    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        resolveModel,
      }),
    ).resolves.toBe(resolved);
    expect(resolveModel).toHaveBeenCalledOnce();
  });

  it("rejects mismatched targets and mismatched resolved tuples", async () => {
    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.6",
        resolveModel: vi.fn(),
      }),
    ).rejects.toThrow(/does not match target/u);

    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        resolveModel: vi.fn(async () => ({
          model: {
            provider: "openai",
            id: "gpt-5.5",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        })),
      }),
    ).rejects.toThrow(/prepared subscription route/u);
  });
});
