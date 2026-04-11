import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";
import {
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  OPENAI_GPT5_EXECUTION_BIAS,
  OPENAI_GPT5_OUTPUT_CONTRACT,
} from "./prompt-overlay.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
  };
});

import { refreshOpenAICodexToken } from "./openai-codex-provider.runtime.js";

const _registerOpenAIPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "openai",
    name: "OpenAI Provider",
  });

async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  const providers: ProviderPlugin[] = [];
  await plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      pluginConfig: params?.pluginConfig,
      on,
      registerProvider: (provider) => {
        providers.push(provider);
      },
    }),
  );
  return { on, providers };
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      finalUrl: "https://api.openai.com/v1/images/generations",
      response: {
        ok: true,
        json: async () => ({
          data: [
            {
              b64_json: Buffer.from("png-data").toString("base64"),
              revised_prompt: "revised",
            },
          ],
        }),
      } as Response,
      release: vi.fn(async () => {}),
    });
    vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "draw a cat",
      cfg: {},
      authStore,
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(postJsonRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: {
          model: "gpt-image-1",
          prompt: "draw a cat",
          n: 1,
          size: "1024x1024",
        },
      }),
    );
    expect(postJsonRequestSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/edits",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("submits reference-image edits to the OpenAI Images edits endpoint", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
      finalUrl: "https://api.openai.com/v1/images/edits",
      response: {
        ok: true,
        json: async () => ({
          data: [
            {
              b64_json: Buffer.from("edited-image").toString("base64"),
            },
          ],
        }),
      } as Response,
      release: vi.fn(async () => {}),
    });
    vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };

    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "Edit this image",
      cfg: {},
      authStore,
      inputImages: [
        { buffer: Buffer.from("x"), mimeType: "image/png" },
        { buffer: Buffer.from("y"), mimeType: "image/jpeg", fileName: "ref.jpg" },
      ],
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(postJsonRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/edits",
        body: {
          model: "gpt-image-1",
          prompt: "Edit this image",
          n: 1,
          size: "1024x1024",
          images: [
            {
              image_url: "data:image/png;base64,eA==",
            },
            {
              image_url: "data:image/jpeg;base64,eQ==",
            },
          ],
        },
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("edited-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-1",
        prompt: "draw a cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bootstraps the env proxy dispatcher before refreshing codex oauth credentials", async () => {
    const refreshed = {
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    };
    runtimeMocks.refreshOpenAICodexToken.mockResolvedValue(refreshed);

    await expect(refreshOpenAICodexToken("refresh-token")).resolves.toBe(refreshed);

    expect(runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledOnce();
    expect(
      runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0],
    ).toBeLessThan(runtimeMocks.refreshOpenAICodexToken.mock.invocationCallOrder[0]);
  });

  it("registers provider-owned OpenAI tool compat hooks for openai and codex", async () => {
    const { providers } = await registerOpenAIPluginWithHook();
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const codexProvider = requireRegisteredProvider(providers, "openai-codex");
    const noParamsTool = {
      name: "ping",
      description: "",
      parameters: {},
      execute: vi.fn(),
    } as never;

    const normalizedOpenAI = openaiProvider.normalizeToolSchemas?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools: [noParamsTool],
    } as never);
    const normalizedCodex = codexProvider.normalizeToolSchemas?.({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelApi: "openai-codex-responses",
      model: {
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
      } as never,
      tools: [noParamsTool],
    } as never);

    expect(normalizedOpenAI?.[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(normalizedCodex?.[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(
      openaiProvider.inspectToolSchemas?.({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        model: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
        } as never,
        tools: [noParamsTool],
      } as never),
    ).toEqual([]);
    expect(
      codexProvider.inspectToolSchemas?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        modelApi: "openai-codex-responses",
        model: {
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          id: "gpt-5.4",
        } as never,
        tools: [noParamsTool],
      } as never),
    ).toEqual([]);
  });

  it("registers GPT-5 system prompt contributions when the friendly overlay is enabled", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const codexProvider = requireRegisteredProvider(providers, "openai-codex");
    const contributionContext: Parameters<
      NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>
    >[0] = {
      config: undefined,
      agentDir: undefined,
      workspaceDir: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      promptMode: "full",
      runtimeChannel: undefined,
      runtimeCapabilities: undefined,
      agentId: undefined,
    };

    expect(openaiProvider.resolveSystemPromptContribution?.(contributionContext)).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("This is a live chat, not a memo.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Avoid walls of text, long preambles, and repetitive restatement.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Have emotional range when it fits the moment.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(codexProvider.resolveSystemPromptContribution?.(contributionContext)).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        modelId: "gpt-image-1",
      }),
    ).toBeUndefined();
  });

  it("includes stronger execution guidance in the OpenAI prompt overlay", () => {
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "If the user asks you to do the work, start in the same turn instead of restating the plan.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'If the latest user message is a short approval like "ok do it" or "go ahead", skip the recap and start acting.',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Commentary-only turns are incomplete when the next action is clear.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'Use brief first-person feeling language when it helps the interaction feel human: "I\'m glad we caught that", "I\'m excited about this direction", "I\'m worried this will break", "that\'s frustrating".',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(OPENAI_GPT5_EXECUTION_BIAS).toContain(
      "Do prerequisite lookup or discovery before dependent actions.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Return the requested sections only, in the requested order.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Prefer commas, periods, or parentheses over em dashes in normal prose.",
    );
    expect(OPENAI_GPT5_OUTPUT_CONTRACT).toContain(
      "Do not use em dashes unless the user explicitly asks for them or they are required in quoted text.",
    );
  });

  it("defaults to the friendly OpenAI interaction-style overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook();

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("supports opting out of the friendly prompt overlay via plugin config", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("treats mixed-case off values as disabling the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "Off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("supports explicitly configuring the friendly prompt overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });

  it("treats on as an alias for the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "on" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_OUTPUT_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
        execution_bias: OPENAI_GPT5_EXECUTION_BIAS,
      },
    });
  });
});
