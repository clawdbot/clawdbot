// Setup tests cover model-resolution hooks and effective runtime model context
// metadata before an embedded run starts.
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE } from "../../../sessions/agent-harness-session-key.js";
import {
  buildBeforeModelResolveAttachments,
  resolveAgentHarnessRunAdmissionError,
  resolveEmbeddedRuntimeModelPolicy,
  resolveHookModelSelection,
  resolveNativeModelOwnedHarnessId,
} from "./setup.js";

const hookContext = {
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
};

describe("agent harness run admission", () => {
  const sessionKey = "agent:main:harness:codex:supervision:native-thread";
  const entry: SessionEntry = {
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    sessionId: "native-session",
    updatedAt: 1,
  };

  it("accepts only the matching requested and durable harness lock", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        agentHarnessId: "codex",
        entry,
        modelSelectionLocked: true,
        sessionId: "native-session",
        sessionKey,
      }),
    ).toBeUndefined();
  });

  it("keeps a pre-existing unlocked harness-prefixed session on the ordinary runtime path", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        entry: {
          agentHarnessId: "openclaw",
          sessionId: "legacy-session",
          updatedAt: 1,
        },
        sessionId: "legacy-session",
        sessionKey: "agent:main:harness:notes",
      }),
    ).toBeUndefined();
  });

  it("accepts an ordinary-key session with the exact durable harness lock", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        agentHarnessId: "codex",
        entry,
        modelSelectionLocked: true,
        sessionId: "native-session",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it("keeps a legacy model-selection lock on the ordinary runtime path", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        entry: {
          modelSelectionLocked: true,
          sessionId: "legacy-session",
          updatedAt: 1,
        },
        sessionId: "legacy-session",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a different session id", { sessionId: "other-session" }],
    ["an omitted runtime lock", { modelSelectionLocked: undefined }],
    ["a different harness", { agentHarnessId: "openclaw" }],
  ])("rejects an ordinary-key locked session with %s", (_label, overrides) => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        agentHarnessId: "codex",
        entry,
        modelSelectionLocked: true,
        sessionId: "native-session",
        sessionKey: "agent:main:main",
        ...overrides,
      }),
    ).toBe(AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE);
  });

  it.each([
    { agentHarnessId: "openclaw", modelSelectionLocked: true, entry },
    { agentHarnessId: "codex", modelSelectionLocked: false, entry },
    { agentHarnessId: "codex", modelSelectionLocked: true, entry: undefined },
    {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      entry: { ...entry, sessionId: "stale-session" },
    },
  ])("rejects a mismatched or missing reserved runtime", (params) => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        ...params,
        sessionId: "native-session",
        sessionKey,
      }),
    ).toContain("reserved");
  });
});

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
  it("does not expose locked model selection to routing hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeModelResolve: vi.fn(),
    };

    await expect(
      resolveHookModelSelection({
        prompt: "private review transcript",
        provider: "foreground-provider",
        modelId: "foreground-model",
        modelSelectionLocked: true,
        hookRunner,
        hookContext,
      }),
    ).resolves.toEqual({
      provider: "foreground-provider",
      modelId: "foreground-model",
    });
    expect(hookRunner.hasHooks).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
  });

  it("passes attachment metadata to before_model_resolve hooks", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png" }];
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => ({
        providerOverride: "vision-provider",
        modelOverride: "vision-model",
      })),
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
    expect(result.provider).toBe("vision-provider");
    expect(result.modelId).toBe("vision-model");
  });

  it("omits the attachments key for text-only before_model_resolve hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => undefined),
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
  // Runtime model fixture uses provider-discovered limits; setup tests compare
  // those against configured model metadata.
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
  // Configured model fixture represents the user/provider config path that can
  // override runtime-discovered context windows.
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

describe("resolveEmbeddedRuntimeModelPolicy", () => {
  it("can read Codex OAuth context overrides for native Codex harness runs", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [createConfiguredModel()],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEmbeddedRuntimeModelPolicy({
      cfg,
      provider: "codex",
      contextConfigProvider: "openai",
      modelId: "gpt-5.5",
      runtimeModel: createRuntimeModel(),
      nativeModelOwned: false,
    });

    expect(result.contextWindowInfo).toEqual({
      source: "modelsConfig",
      tokens: 1_000_000,
    });
    expect(result.effectiveModel.contextWindow).toBe(1_000_000);
  });

  it("keeps the runtime model contextTokens when no alternate context provider is supplied", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [createConfiguredModel()],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveEmbeddedRuntimeModelPolicy({
      cfg,
      provider: "codex",
      modelId: "gpt-5.5",
      runtimeModel: createRuntimeModel(),
      nativeModelOwned: false,
    });

    expect(result.contextWindowInfo).toEqual({
      source: "model",
      tokens: 272_000,
    });
    expect(result.effectiveModel.contextWindow).toBe(272_000);
  });
});

describe("native model-owned harness policy", () => {
  it("requires an exact pinned, locked, non-default harness", () => {
    expect(
      resolveNativeModelOwnedHarnessId({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        selectedHarnessId: "codex",
      }),
    ).toBe("codex");
    expect(
      resolveNativeModelOwnedHarnessId({
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        selectedHarnessId: "codex",
      }),
    ).toBeUndefined();
    expect(
      resolveNativeModelOwnedHarnessId({
        agentHarnessId: "openclaw",
        modelSelectionLocked: true,
        selectedHarnessId: "openclaw",
      }),
    ).toBeUndefined();
    expect(
      resolveNativeModelOwnedHarnessId({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        selectedHarnessId: "other",
      }),
    ).toBeUndefined();
  });

  it("does not apply outer context guards or budgets", () => {
    const runtimeModel = createRuntimeModel();
    const result = resolveEmbeddedRuntimeModelPolicy({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [createConfiguredModel({ contextWindow: 1, contextTokens: 1 })],
            },
          },
        },
      },
      provider: "openai",
      modelId: runtimeModel.id,
      runtimeModel,
      nativeModelOwned: true,
    });

    expect(result).toEqual({ effectiveModel: runtimeModel });
  });
});
