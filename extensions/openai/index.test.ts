import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

vi.mock("@earendil-works/pi-ai/oauth", () => ({
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

function firstMockArg(mocked: unknown): Record<string, unknown> {
  const arg = (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0]?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("Expected first mock argument");
  }
  return arg as Record<string, unknown>;
}

function mockCalls(mocked: unknown): unknown[][] {
  return (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
}

function expectNoBeforePromptBuildHook(on: unknown): void {
  const hasBeforePromptBuild = mockCalls(on).some((call) => call[0] === "before_prompt_build");
  expect(hasBeforePromptBuild).toBe(false);
}

function expectNoRequestUrl(mocked: unknown, url: string): void {
  const hasUrl = mockCalls(mocked).some((call) => {
    const arg = call[0] as { url?: unknown } | undefined;
    return arg?.url === url;
  });
  expect(hasUrl).toBe(false);
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    const authArgs = firstMockArg(resolveApiKeySpy);
    expect(authArgs.provider).toBe("openai");
    expect(authArgs.store).toBe(authStore);
    const requestArgs = firstMockArg(postJsonRequestSpy);
    expect(requestArgs.url).toBe("https://api.openai.com/v1/images/generations");
    expect(requestArgs.body).toEqual({
      model: "gpt-image-2",
      prompt: "draw a cat",
      n: 2,
      size: "2048x2048",
    });
    expectNoRequestUrl(postJsonRequestSpy, "https://api.openai.com/v1/images/edits");
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

    const authArgs = firstMockArg(resolveApiKeySpy);
    expect(authArgs.provider).toBe("openai");
    expect(authArgs.store).toBe(authStore);
    const multipartArgs = firstMockArg(postMultipartRequestSpy);
    expect(multipartArgs.url).toBe("https://api.openai.com/v1/images/edits");
    expect(multipartArgs.body).toBeInstanceOf(FormData);
    expect(multipartArgs.allowPrivateNetwork).toBe(false);
    expect(multipartArgs.dispatcherPolicy).toBeUndefined();
    expect(multipartArgs.fetchFn).toBe(fetch);
    const editCallArgs = multipartArgs as unknown as {
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
    expectNoRequestUrl(postJsonRequestSpy, "https://api.openai.com/v1/images/edits");
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
    ).toStrictEqual([]);
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
    ).toStrictEqual([]);
  });

  it("registers GPT-5 system prompt contributions when the friendly overlay is enabled", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expectNoBeforePromptBuildHook(on);

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
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Live chat tone: short, natural, human.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Avoid memo voice, long preambles, walls of text, and repetitive restatement.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Show grounded emotional range when it fits");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are fine when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
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
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Keep progress updates concrete.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      'Brief first-person feeling language is ok when useful: "I\'m glad we caught that", "I\'m excited about this direction", "I\'m worried this will break", "that\'s frustrating".',
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).not.toContain(
      "Use heartbeats to create useful proactive progress",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Use heartbeats to create useful proactive progress, not chatter.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Treat a heartbeat as a wake-up: orient, read HEARTBEAT.md when present, then do what is actually useful now.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "If HEARTBEAT.md assigns concrete or ongoing work, execute its spirit with judgment.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Prefer meaningful action over commentary. A good heartbeat often looks like silent progress.",
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      'Do not send "same state", "no change", "still", or repetitive summaries because a problem continues.',
    );
    expect(OPENAI_HEARTBEAT_PROMPT_OVERLAY).toContain(
      "Notify only for something worth interrupting the user",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Occasional emoji are fine when they fit naturally, especially for warmth or brief celebration; keep them sparse.",
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

    expectNoBeforePromptBuildHook(on);
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {
      interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });
  });

  it("supports opting out of the friendly prompt overlay via plugin config", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    expectNoBeforePromptBuildHook(on);
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

    expectNoBeforePromptBuildHook(on);
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
