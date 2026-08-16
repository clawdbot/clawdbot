import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  materializePreparedRuntimeModel,
  PREPARED_RUNTIME_MODEL_MATERIALIZATION_REASON_CODES,
  readPreparedRuntimeModelMaterializationReason,
  type PreparedRuntimeModelMaterializationReason,
} from "./materialize-model.js";
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

const SECRET_BEARING_ERROR =
  "Unable to refresh SecretRef token=sk-secret-token for https://chatgpt.com/backend-api/codex profile openai:subscription Authorization: Bearer leaked";

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(collectStrings);
}

function expectReasonRedacted(reason: PreparedRuntimeModelMaterializationReason | undefined) {
  expect(reason).toBeDefined();
  const serialized = JSON.stringify(reason);
  expect(serialized).not.toMatch(/https?:\/\//u);
  expect(serialized).not.toMatch(/chatgpt\.com|api\.openai\.com/u);
  expect(serialized).not.toMatch(/openai:(?:subscription|backup|key)/u);
  expect(serialized).not.toMatch(/SecretRef|Bearer|Authorization|sk-secret-token/u);
  for (const text of collectStrings(reason)) {
    expect(text).not.toMatch(/https?:\/\//u);
    expect(text).not.toContain("openai:subscription");
    expect(text).not.toContain("sk-secret-token");
  }
}

async function expectClosedReason(
  run: () => Promise<unknown>,
  expected: Partial<PreparedRuntimeModelMaterializationReason> &
    Pick<PreparedRuntimeModelMaterializationReason, "code">,
) {
  try {
    await run();
    throw new Error(`expected ${expected.code} materialization failure`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("Error");
    expect(Object.keys(error as object)).not.toContain("reason");
    expect(JSON.stringify(error)).not.toMatch(/https?:\/\//u);
    const reason = readPreparedRuntimeModelMaterializationReason(error);
    expect(reason).toMatchObject(expected);
    expectReasonRedacted(reason);
    return { error: error as Error, reason };
  }
}

describe("materializePreparedRuntimeModel closed reasons", () => {
  it("assigns a distinct closed reason to every fail-closed predicate", async () => {
    const missing = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.5",
          resolveModel: vi.fn(async () => ({ error: SECRET_BEARING_ERROR })),
        }),
      {
        code: "resolved-model-missing",
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    );
    expect(missing.error.message).toBe(SECRET_BEARING_ERROR);

    const providerMismatch = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.5",
          resolveModel: vi.fn(async () => ({
            error: SECRET_BEARING_ERROR,
            model: {
              provider: "github-copilot",
              id: "gpt-5.5",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          })),
        }),
      {
        code: "resolved-provider-mismatch",
        provider: "openai",
        modelId: "gpt-5.5",
        actualProvider: "github-copilot",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    );

    const modelMismatch = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.5",
          resolveModel: vi.fn(async () => ({
            model: {
              provider: "openai",
              id: "gpt-5.4",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          })),
        }),
      {
        code: "resolved-model-mismatch",
        provider: "openai",
        modelId: "gpt-5.5",
        actualModelId: "gpt-5.4",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    );

    const routeMismatch = await expectClosedReason(
      () =>
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
      {
        code: "resolved-route-mismatch",
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        actualApi: "openai-responses",
        authRequirement: "subscription",
      },
    );

    const preparedTarget = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.6",
          resolveModel: vi.fn(),
        }),
      {
        code: "prepared-target-mismatch",
        provider: "openai",
        modelId: "gpt-5.6",
        actualProvider: "openai",
        actualModelId: "gpt-5.5",
      },
    );

    const callerMismatch = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.5",
          rejectMismatchedModel: true,
          model: {
            provider: "openai",
            id: "gpt-5.5",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
          resolveModel: vi.fn(),
        }),
      {
        code: "caller-model-mismatch",
        provider: "openai",
        modelId: "gpt-5.5",
        actualProvider: "openai",
        actualModelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        actualApi: "openai-completions",
        authRequirement: "subscription",
      },
    );

    const resolvedCodes = [
      missing.reason?.code,
      providerMismatch.reason?.code,
      modelMismatch.reason?.code,
      routeMismatch.reason?.code,
    ];
    expect(new Set(resolvedCodes).size).toBe(4);
    expect(providerMismatch.error.message).toBe(SECRET_BEARING_ERROR);
    expect(modelMismatch.error.message).toBe(
      "Unable to materialize openai/gpt-5.5 for its prepared subscription route.",
    );
    expect(routeMismatch.error.message).toBe(modelMismatch.error.message);
    expect(preparedTarget.error.message).toMatch(/does not match target/u);
    expect(callerMismatch.error.message).toMatch(/does not match its prepared subscription route/u);
    expect(PREPARED_RUNTIME_MODEL_MATERIALIZATION_REASON_CODES).toEqual([
      "resolved-model-missing",
      "resolved-provider-mismatch",
      "resolved-model-mismatch",
      "resolved-route-mismatch",
      "prepared-target-mismatch",
      "caller-model-mismatch",
    ]);
  });

  it("keeps exact-route success and fail-closed order as controls", async () => {
    const matching = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const resolveModel = vi.fn(async () => ({
      model: {
        provider: "github-copilot",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: matching.baseUrl,
      },
    }));

    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        model: matching,
        resolveModel,
      }),
    ).resolves.toBe(matching);
    expect(resolveModel).not.toHaveBeenCalled();

    const missingThenMismatch = vi.fn(async () => ({
      error: SECRET_BEARING_ERROR,
      model: {
        provider: "github-copilot",
        id: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    }));
    const ordered = await expectClosedReason(
      () =>
        materializePreparedRuntimeModel({
          plan,
          provider: "openai",
          modelId: "gpt-5.5",
          resolveModel: missingThenMismatch,
        }),
      { code: "resolved-provider-mismatch" },
    );
    expect(ordered.error.message).toBe(SECRET_BEARING_ERROR);
    expect(missingThenMismatch).toHaveBeenCalledOnce();
  });

  it("does not attach a reason to ordinary resolve throws", async () => {
    const failure = new Error(SECRET_BEARING_ERROR);
    await expect(
      materializePreparedRuntimeModel({
        plan,
        provider: "openai",
        modelId: "gpt-5.5",
        resolveModel: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(readPreparedRuntimeModelMaterializationReason(failure)).toBeUndefined();
  });
});
