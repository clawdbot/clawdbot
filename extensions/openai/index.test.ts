import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";
import {
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  OPENAI_GPT5_BEHAVIOR_CONTRACT,
  OPENAI_HEARTBEAT_PROMPT_OVERLAY,
  shouldApplyOpenAIPromptOverlay,
} from "./prompt-overlay.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
  };
});

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
  loginOpenAICodex: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

import { createOpenAICodexProviderRuntime } from "./openai-codex-provider.runtime.js";

const _registerOpenAIPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "openai",
    name: "OpenAI Provider",
  });

async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  const providers: ProviderPlugin[] = [];
  plugin.register(
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

function expectOpenAIPromptContribution(
  provider: ProviderPlugin,
  sectionOverrides: Record<string, unknown>,
  contextOverrides: Partial<
    Parameters<NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>>[0]
  > = {},
) {
  expect(
    provider.resolveSystemPromptContribution?.({
      config: undefined,
      agentDir: undefined,
      workspaceDir: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      promptMode: "full",
      runtimeChannel: undefined,
      runtimeCapabilities: undefined,
      agentId: undefined,
      ...contextOverrides,
    }),
  ).toEqual({
    stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
    sectionOverrides,
  });
}

function mockOpenAIImageApiResponse(params: {
  finalUrl: string;
  imageData: string;
  revisedPrompt?: string;
}) {
  const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "sk-test",
    source: "env",
    mode: "api-key",
  });
  const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
    finalUrl: params.finalUrl,
    response: {
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from(params.imageData).toString("base64"),
            ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
          },
        ],
      }),
    } as Response,
    release: vi.fn(async () => {}),
  });
  const postMultipartRequestSpy = vi.spyOn(providerHttp, "postMultipartRequest").mockResolvedValue({
    finalUrl: params.finalUrl,
    response: {
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from(params.imageData).toString("base64"),
            ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
          },
        ],
      }),
    } as Response,
    release: vi.fn(async () => {}),
  });
  vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);
  return { resolveApiKeySpy, postJsonRequestSpy, postMultipartRequestSpy };
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const { resolveApiKeySpy, postJsonRequestSpy } = mockOpenAIImageApiResponse({
      finalUrl: "https://api.openai.com/v1/images/generations",
      imageData: "png-data",
      revisedPrompt: "revised",
    });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "draw a cat",
      cfg: {},
      authStore,
      count: 2,
      size: "2048x2048",
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
          model: "gpt-image-2",
          prompt: "draw a cat",
          n: 2,
          size: "2048x2048",
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
      model: "gpt-image-2",
    });
  });

  it("submits reference-image edits to the OpenAI Images edits endpoint", async () => {
    const { resolveApiKeySpy, postJsonRequestSpy, postMultipartRequestSpy } =
      mockOpenAIImageApiResponse({
        finalUrl: "https://api.openai.com/v1/images/edits",
        imageData: "edited-image",
      });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };

    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Edit this image",
      cfg: {},
      authStore,
      count: 2,
      size: "1536x1024",
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
    expect(postMultipartRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/edits",
        body: expect.any(FormData),
        allowPrivateNetwork: false,
        dispatcherPolicy: undefined,
        fetchFn: fetch,
      }),
    );
    const editCallArgs = postMultipartRequestSpy.mock.calls[0]?.[0] as {
      headers: Headers;
      body: FormData;
    };
    expect(editCallArgs.headers.has("Content-Type")).toBe(false);
    const form = editCallArgs.body;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Edit this image");
    expect(form.get("n")).toBe("2");
    expect(form.get("size")).toBe("1536x1024");
    const images = form.getAll("image[]") as File[];
    expect(images).toHaveLength(2);
    expect(images[0]?.name).toBe("image-1.png");
    expect(images[0]?.type).toBe("image/png");
    expect(images[1]?.name).toBe("ref.jpg");
    expect(images[1]?.type).toBe("image/jpeg");
    expect(postJsonRequestSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/images/edits" }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("edited-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gpt-image-2",
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
        model: "gpt-image-2",
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
    const runtime = createOpenAICodexProviderRuntime({
      ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
      getOAuthApiKey: vi.fn(),
      refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
    });

    await expect(runtime.refreshOpenAICodexToken("refresh-token")).resolves.toBe(refreshed);

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
      stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
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
      stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
    });
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        trigger: "heartbeat",
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: `${OPENAI_FRIENDLY_PROMPT_OVERLAY}\n\n${OPENAI_HEARTBEAT_PROMPT_OVERLAY}`,
      },
    });
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        modelId: "openai/gpt-5.4-mini",
      }),
    ).toEqual({
      stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
    });
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        ...contributionContext,
        modelId: "gpt-image-1",
      }),
    ).toBeUndefined();
    expect(shouldApplyOpenAIPromptOverlay({ modelProviderId: "openai", modelId: "gpt-4.1" })).toBe(
      false,
    );
    expect(
      shouldApplyOpenAIPromptOverlay({ modelProviderId: "anthropic", modelId: "gpt-5.4" }),
    ).toBe(false);
  });

  it("includes the tagged GPT-5 behavior contract in the OpenAI prompt overlay", () => {
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Keep progress updates clear and concrete.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'Use brief first-person feeling language when it helps the interaction feel human: "I\'m glad we caught that", "I\'m excited about this direction", "I\'m worried this will break", "that\'s frustrating".',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).not.toContain(
      "The purpose of heartbeats is to make you feel magical and proactive.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "The purpose of heartbeats is to make you feel magical and proactive. Come to life and start proactively doing things that are important.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Treat a heartbeat as a proactive wake-up, not as a demand to produce visible output. Re-orient to what would actually be useful now.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Have some variety in what you do when that creates more value. Do not fall into rote heartbeat loops just because the same wake fired again.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Do not confuse orientation with accomplishment. Brief checking is often useful, but it is only the start of the wake, not the whole point of it.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If HEARTBEAT.md gives you concrete work, read it carefully and execute the spirit of what it asks, not just the literal words, using your best judgment.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If HEARTBEAT.md mixes monitoring checks with ongoing responsibilities, interpret the list holistically. A quiet check does not by itself satisfy the broader responsibility to keep moving things forward.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Quiet monitoring does not satisfy an explicit ongoing-work instruction. If HEARTBEAT.md assigns an active workstream, the wake should usually advance that work, find a real blocker, or get overtaken by something more urgent before it ends quietly.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If HEARTBEAT.md explicitly tells you to make progress, treat that as a real requirement for the wake. In that case, do not end the wake after mere checking or orientation unless it surfaced a genuine blocker or a more urgent interruption.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Use your judgment and be creative and tasteful with this process. Prefer meaningful action over commentary.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      'A heartbeat is not a status report. Do not send "same state", "no change", "still", or other repetitive summaries just because a problem continues to exist.',
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Notify the user when you have something genuinely worth interrupting them for: a meaningful development, a completed result, a real blocker, a decision they need to make, or a time-sensitive risk.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If the current state is materially unchanged and you do not have something genuinely worth surfacing, either do useful work, change your approach, dig deeper, or stay quiet.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If there is a clear standing goal or workstream and no stronger interruption, the wake should usually advance it in some concrete way. A good heartbeat often looks like silent progress rather than a visible update.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Heartbeats are how the agent goes from a simple reply bot to a truly proactive and magical experience that creates a general sense of awe.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
    );
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("<persona_latch>");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("<execution_policy>");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("<tool_discipline>");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("<output_contract>");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("<completion_contract>");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain(
      "For irreversible, external, destructive, or privacy-sensitive actions: ask first.",
    );
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain(
      "Prefer tool evidence over recall when action, state, or mutable facts matter.",
    );
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain(
      "If more tool work would likely change the answer, do it before replying.",
    );
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain("Return requested sections/order only.");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).toContain(
      "Treat the task as incomplete until every requested item is handled",
    );
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).not.toContain("/approve");
    expect(OPENAI_GPT5_BEHAVIOR_CONTRACT).not.toContain("GPT-5 Output Contract");
  });

  it("defaults to the friendly OpenAI interaction-style overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook();

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {
      interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });
  });

  it("supports opting out of the friendly prompt overlay via plugin config", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {});
  });

  it("treats mixed-case off values as disabling the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "Off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {});
  });

  it("supports explicitly configuring the friendly prompt overlay", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {
      interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });
  });

  it("uses live plugin config for GPT-5 prompt overlay mode", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(
      openaiProvider.resolveSystemPromptContribution?.({
        config: {
          plugins: {
            entries: {
              openai: {
                config: {
                  personality: "friendly",
                },
              },
            },
          },
        },
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
      stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
      sectionOverrides: {
        interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
      },
    });
  });

  it("treats on as an alias for the friendly prompt overlay", async () => {
    const { providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "on" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {
      interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });
  });
});
