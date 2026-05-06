import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import {
  buildBeforeModelResolveAttachments,
  resolveEffectiveRuntimeModel,
  resolveHookModelSelection,
} from "./setup.js";

const hookContext = {
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
};

describe("buildBeforeModelResolveAttachments", () => {
  it("maps prompt image metadata to before_model_resolve attachments", () => {
    expect(
      buildBeforeModelResolveAttachments([{ mimeType: "image/png" }, { mimeType: "image/jpeg" }]),
    ).toEqual([
      { kind: "image", mimeType: "image/png" },
      { kind: "image", mimeType: "image/jpeg" },
    ]);
  });

  it("omits attachments when there are no images", () => {
    expect(buildBeforeModelResolveAttachments(undefined)).toBeUndefined();
    expect(buildBeforeModelResolveAttachments([])).toBeUndefined();
  });
});

describe("resolveHookModelSelection", () => {
  it("passes attachment metadata to before_model_resolve hooks", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png" }];
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => ({
        providerOverride: "vision-provider",
        modelOverride: "vision-model",
      })),
      runBeforeAgentStart: vi.fn(),
    };

    const result = await resolveHookModelSelection({
      prompt: "describe this image",
      attachments,
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "describe this image", attachments },
      hookContext,
    );
    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result.provider).toBe("vision-provider");
    expect(result.modelId).toBe("vision-model");
  });

  it("omits the attachments key for text-only before_model_resolve hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(),
    };

    await resolveHookModelSelection({
      prompt: "text only",
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "text only" },
      hookContext,
    );
  });
});

function createRuntimeModel(): ProviderRuntimeModel {
  return {
    provider: "openai",
    id: "gpt-5.5",
    name: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    contextTokens: 272_000,
    maxTokens: 128_000,
  };
}

function createConfiguredModel(
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id: "gpt-5.5",
    name: "gpt-5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    contextTokens: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  };
}

describe("resolveEffectiveRuntimeModel", () => {
  it("can read Codex OAuth context overrides for native Codex harness runs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [createConfiguredModel()],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEffectiveRuntimeModel({
      cfg,
      provider: "openai",
      contextConfigProvider: "openai-codex",
      modelId: "gpt-5.5",
      runtimeModel: createRuntimeModel(),
    });

    expect(result.ctxInfo).toEqual({
      source: "modelsConfig",
      tokens: 1_000_000,
    });
    expect(result.effectiveModel.contextWindow).toBe(1_000_000);
  });

  it("keeps the runtime model contextTokens when no alternate context provider is supplied", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [createConfiguredModel()],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEffectiveRuntimeModel({
      cfg,
      provider: "openai",
      modelId: "gpt-5.5",
      runtimeModel: createRuntimeModel(),
    });

    expect(result.ctxInfo).toEqual({
      source: "model",
      tokens: 272_000,
    });
    expect(result.effectiveModel.contextWindow).toBe(272_000);
  });
});
