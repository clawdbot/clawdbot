// Vision skip tests cover auto image-model selection and text-only model
// rejection across bundled provider metadata.
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "../plugins/bundled-compat.js";
import { resolvePluginRegistryLoadCacheKey } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { withMediaFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type TestCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  input: readonly string[];
};

const baseCatalog: TestCatalogEntry[] = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
];
let catalog: TestCatalogEntry[] = [...baseCatalog];
const plantedVisionSentinel = "PLANTED_VISION_DESC_zq7x";

const loadModelCatalog = vi.hoisted(() => vi.fn(async () => catalog));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const runtime =
    await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
  return {
    resolvePluginCapabilityProviders: ({ key }: { key: string }) =>
      key === "mediaUnderstandingProviders"
        ? (runtime
            .getActivePluginRegistry()
            ?.mediaUnderstandingProviders.map((entry) => entry.provider) ?? [])
        : [],
  };
});

vi.mock("../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog,
  };
});

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
let resolveAutoImageModel: typeof import("./runner.js").resolveAutoImageModel;
let runCapability: typeof import("./runner.js").runCapability;

function setCompatibleActiveMediaUnderstandingRegistry(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  cfg: OpenClawConfig,
) {
  const pluginIds = loadPluginManifestRegistry({
    config: cfg,
    env: process.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const compatibleConfig = withBundledPluginVitestCompat({
    config: withBundledPluginEnablementCompat({
      config: cfg,
      pluginIds,
    }),
    pluginIds,
    env: process.env,
  });
  const cacheKey = resolvePluginRegistryLoadCacheKey({
    config: compatibleConfig,
    env: process.env,
  });
  setActivePluginRegistry(pluginRegistry, cacheKey);
}

type CapabilityResult = Awaited<ReturnType<typeof runCapability>>;

function requireDecisionAttachment(result: CapabilityResult, index: number) {
  const attachment = result.decision.attachments[index];
  if (!attachment) {
    throw new Error(`expected media-understanding decision attachment ${index}`);
  }
  return attachment;
}

function requireCapabilityOutput(result: CapabilityResult, index: number) {
  const output = result.outputs[index];
  if (!output) {
    throw new Error(`expected media-understanding output ${index}`);
  }
  return output;
}

describe("runCapability image skip", () => {
  beforeAll(async () => {
    vi.doMock("../agents/model-catalog.js", async () => {
      const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
        "../agents/model-catalog.js",
      );
      return {
        ...actual,
        loadModelCatalog,
      };
    });
    ({ buildProviderRegistry, resolveAutoImageModel, runCapability } = await import("./runner.js"));
    ({ applyMediaUnderstanding } = await import("./apply.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    loadModelCatalog.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it("skips image understanding when the active model supports vision", async () => {
    const ctx: MsgContext = { MediaPath: "/tmp/image.png", MediaType: "image/png" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    const cfg = {} as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "image",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: buildProviderRegistry(),
        activeModel: { provider: "openai", model: "gpt-4.1" },
      });

      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      const attachment = requireDecisionAttachment(result, 0);
      expect(attachment.attachmentIndex).toBe(0);
      const attempt = attachment.attempts[0];
      if (!attempt) {
        throw new Error("expected media-understanding skipped attempt");
      }
      expect(attempt.outcome).toBe("skipped");
      expect(attempt.reason).toBe("primary model supports vision natively");
    } finally {
      await cache.cleanup();
    }
  });

  it("skips agents.defaults.imageModel fallback when the active model supports vision", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-default-model-native-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx }) => {
        let describeCalls = 0;
        const msgCtx = ctx as MsgContext;
        msgCtx.Body = "please inspect this image";
        const cfg = {
          agents: {
            defaults: {
              imageModel: { primary: "minimax/MiniMax-M3" },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await applyMediaUnderstanding({
          ctx: msgCtx,
          cfg,
          agentDir: "/tmp",
          workspaceDir: path.dirname(ctx.MediaPath),
          providers: {
            minimax: {
              id: "minimax",
              capabilities: ["image"],
              describeImage: async (req) => {
                describeCalls += 1;
                return { text: plantedVisionSentinel, model: req.model };
              },
            },
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        const imageDecision = result.decisions.find((decision) => decision.capability === "image");
        const attempt = imageDecision?.attachments[0]?.attempts[0];
        expect(result.appliedImage).toBe(false);
        expect(imageDecision?.outcome).toBe("skipped");
        expect(attempt?.outcome).toBe("skipped");
        expect(attempt?.reason).toBe("primary model supports vision natively");
        expect(describeCalls).toBe(0);
        expect(msgCtx.Body).not.toContain(plantedVisionSentinel);
      },
    );
  });

  it("skips agents.defaults.imageModel fallback when MiniMax M3 supports vision", async () => {
    catalog = [
      ...baseCatalog,
      {
        id: "MiniMax-M3",
        name: "MiniMax M3",
        provider: "minimax",
        input: ["text", "image"] as const,
      },
    ];

    await withMediaFixture(
      {
        filePrefix: "openclaw-image-default-model-minimax-m3-native-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx }) => {
        let describeCalls = 0;
        const msgCtx = ctx as MsgContext;
        msgCtx.Body = "please inspect this minimax image";
        const cfg = {
          agents: {
            defaults: {
              imageModel: { primary: "minimax/MiniMax-M3" },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await applyMediaUnderstanding({
          ctx: msgCtx,
          cfg,
          agentDir: "/tmp",
          workspaceDir: path.dirname(ctx.MediaPath),
          providers: {
            minimax: {
              id: "minimax",
              capabilities: ["image"],
              describeImage: async (req) => {
                describeCalls += 1;
                return { text: plantedVisionSentinel, model: req.model };
              },
            },
          },
          activeModel: { provider: "minimax", model: "MiniMax-M3" },
        });

        const imageDecision = result.decisions.find((decision) => decision.capability === "image");
        const attempt = imageDecision?.attachments[0]?.attempts[0];
        expect(result.appliedImage).toBe(false);
        expect(imageDecision?.outcome).toBe("skipped");
        expect(attempt?.outcome).toBe("skipped");
        expect(attempt?.reason).toBe("primary model supports vision natively");
        expect(describeCalls).toBe(0);
        expect(msgCtx.Body).not.toContain(plantedVisionSentinel);
      },
    );
  });

  it("uses explicit media image models even when the active model supports vision", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-explicit-model-no-native-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx }) => {
        let describeCalls = 0;
        const msgCtx = ctx as MsgContext;
        msgCtx.Body = "please inspect this explicit image";
        const cfg = {
          tools: {
            media: {
              image: {
                models: [{ provider: "openrouter", model: "google/gemini-2.5-flash" }],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await applyMediaUnderstanding({
          ctx: msgCtx,
          cfg,
          agentDir: "/tmp",
          workspaceDir: path.dirname(ctx.MediaPath),
          providers: {
            openrouter: {
              id: "openrouter",
              capabilities: ["image"],
              describeImage: async (req) => {
                describeCalls += 1;
                return { text: plantedVisionSentinel, model: req.model };
              },
            },
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        const imageDecision = result.decisions.find((decision) => decision.capability === "image");
        expect(result.appliedImage).toBe(true);
        expect(imageDecision?.outcome).toBe("success");
        expect(describeCalls).toBe(1);
        expect(msgCtx.Body).toContain(plantedVisionSentinel);
      },
    );
  });

  it("uses explicit media image models instead of native vision skip", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-explicit-vision",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {} as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "openrouter",
              {
                id: "openrouter",
                capabilities: ["image"],
                describeImage: async (req) => ({ text: "explicit ok", model: req.model }),
              },
            ],
          ]),
          config: {
            models: [{ provider: "openrouter", model: "google/gemini-2.5-flash" }],
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        expect(result.decision.outcome).toBe("success");
        expect(requireCapabilityOutput(result, 0)).toEqual({
          kind: "image.description",
          attachmentIndex: 0,
          provider: "openrouter",
          model: "google/gemini-2.5-flash",
          text: "explicit ok",
        });
      },
    );
  });

  it("lets per-request image prompts override entry prompts", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-request-prompt",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        let seenPrompt: string | undefined;
        const cfg = {} as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "openrouter",
              {
                id: "openrouter",
                capabilities: ["image"],
                describeImage: async (req) => {
                  seenPrompt = req.prompt;
                  return { text: "request prompt ok", model: req.model };
                },
              },
            ],
          ]),
          config: {
            _requestPromptOverride: "Use this request prompt",
            models: [
              {
                provider: "openrouter",
                model: "google/gemini-2.5-flash",
                prompt: "entry prompt",
              },
            ],
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenPrompt).toBe("Use this request prompt");
      },
    );
  });

  it("keeps agents.defaults.imageModel available to exported auto image resolution", async () => {
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "openrouter/google/gemini-2.5-flash" },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      resolveAutoImageModel({
        cfg,
        activeModel: { provider: "openai", model: "gpt-4.1" },
      }),
    ).resolves.toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
  });

  it("runs providerless configured imageModel fallbacks on the unique configured provider", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-providerless-fallbacks",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          agents: {
            defaults: {
              imageModel: {
                primary: "moondream",
                fallbacks: ["qwen2.5vl:7b"],
              },
            },
          },
          models: {
            providers: {
              ollama: {
                models: [
                  {
                    id: "moondream",
                    input: ["text", "image"],
                  },
                  {
                    id: "qwen2.5vl:7b",
                    input: ["text", "image"],
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "ollama",
              {
                id: "ollama",
                capabilities: ["image"],
                describeImage: async (req) => {
                  if (req.model === "moondream") {
                    throw new Error("primary blocked");
                  }
                  return { text: `ok ${req.model}`, model: req.model };
                },
              } satisfies MediaUnderstandingProvider,
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(requireCapabilityOutput(result, 0)).toEqual({
          kind: "image.description",
          attachmentIndex: 0,
          provider: "ollama",
          model: "qwen2.5vl:7b",
          text: "ok qwen2.5vl:7b",
        });
        const attachment = requireDecisionAttachment(result, 0);
        expect(attachment.attempts).toEqual([
          expect.objectContaining({
            type: "provider",
            provider: "ollama",
            model: "moondream",
            outcome: "failed",
          }),
          expect.objectContaining({
            type: "provider",
            provider: "ollama",
            model: "qwen2.5vl:7b",
            outcome: "success",
          }),
        ]);
      },
    );
  });

  it("falls back from a MiniMax chat model to the provider image default", async () => {
    catalog = [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
      {
        id: "MiniMax-VL-01",
        name: "MiniMax VL 01",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
    ];
    vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
    const cfg = {
      models: {
        providers: {
          "minimax-portal": {
            models: [
              {
                id: "MiniMax-M2.7",
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "minimax",
      pluginName: "MiniMax Provider",
      source: "test",
      provider: {
        id: "minimax-portal",
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        describeImage: async () => ({ text: "ok" }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await expect(
        resolveAutoImageModel({
          cfg,
          activeModel: { provider: "minimax-portal", model: "MiniMax-M2.7" },
        }),
      ).resolves.toEqual({
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("routes legacy MiniMax chat models through the VLM fallback even when cataloged with image input", async () => {
    catalog = [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
    ];
    vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
    const cfg = {
      models: {
        providers: {
          "minimax-portal": {
            models: [
              {
                id: "MiniMax-M2.7",
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "minimax",
      pluginName: "MiniMax Provider",
      source: "test",
      provider: {
        id: "minimax-portal",
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        describeImage: async (req) => ({ text: "vlm ok", model: req.model }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await withMediaFixture(
        {
          filePrefix: "openclaw-minimax-vlm-no-native-skip",
          extension: "png",
          mediaType: "image/png",
          fileContents: Buffer.from("image"),
        },
        async ({ ctx, media, cache }) => {
          const result = await runCapability({
            capability: "image",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir: "/tmp",
            providerRegistry: buildProviderRegistry(undefined, cfg),
            activeModel: { provider: "minimax-portal", model: "MiniMax-M2.7" },
          });

          expect(result.decision.outcome).toBe("success");
          expect(requireCapabilityOutput(result, 0)).toEqual({
            kind: "image.description",
            attachmentIndex: 0,
            provider: "minimax-portal",
            model: "MiniMax-VL-01",
            text: "vlm ok",
          });
        },
      );
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("preserves MiniMax CN aliases from configured provider routing", async () => {
    const seenProviders: string[] = [];
    const cfg = {
      models: {
        providers: {
          "minimax-cn": {
            apiKey: "test-minimax-key",
            baseUrl: "https://api.minimaxi.com/anthropic",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "minimax",
      pluginName: "MiniMax Provider",
      source: "test",
      provider: {
        id: "minimax",
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        describeImage: async (req) => {
          seenProviders.push(req.provider);
          return { text: "cn vlm ok", model: req.model };
        },
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await withMediaFixture(
        {
          filePrefix: "openclaw-minimax-cn-provider",
          extension: "png",
          mediaType: "image/png",
          fileContents: Buffer.from("image"),
        },
        async ({ ctx, media, cache }) => {
          const result = await runCapability({
            capability: "image",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir: "/tmp",
            providerRegistry: buildProviderRegistry(undefined, cfg),
          });

          expect(result.decision.outcome).toBe("success");
          expect(seenProviders).toEqual(["minimax-cn"]);
          expect(requireCapabilityOutput(result, 0)).toEqual({
            kind: "image.description",
            attachmentIndex: 0,
            provider: "minimax-cn",
            model: "MiniMax-VL-01",
            text: "cn vlm ok",
          });
        },
      );
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("keeps MiniMax auto routing on VLM when registry lacks a default model", async () => {
    let seenModel: string | undefined;
    await withMediaFixture(
      {
        filePrefix: "openclaw-minimax-vlm-default",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              minimax: {
                apiKey: "test-minimax-key",
                baseUrl: "https://api.minimax.io/anthropic",
                models: [
                  {
                    id: "MiniMax-M2.5",
                    name: "MiniMax M2.5",
                    reasoning: false,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        } as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "minimax",
              {
                id: "minimax",
                capabilities: ["image"],
                describeImage: async (req) => {
                  seenModel = req.model;
                  return { text: "vlm ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenModel).toBe("MiniMax-VL-01");
        expect(requireCapabilityOutput(result, 0)).toMatchObject({
          provider: "minimax",
          model: "MiniMax-VL-01",
          text: "vlm ok",
        });
      },
    );
  });

  it("keeps non-MiniMax media aliases canonical for image execution", async () => {
    const seenProviders: string[] = [];
    const cfg = {
      tools: {
        media: {
          image: {
            models: [{ provider: "gemini", model: "gemini-3-flash-preview" }],
          },
        },
      },
    } as OpenClawConfig;
    const providerRegistry = new Map<string, MediaUnderstandingProvider>([
      [
        "google",
        {
          id: "google",
          capabilities: ["image" as const],
          describeImage: async (req) => {
            seenProviders.push(req.provider);
            return { text: "google ok", model: req.model };
          },
        },
      ],
    ]);

    await withMediaFixture(
      {
        filePrefix: "openclaw-gemini-media-alias",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry,
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenProviders).toEqual(["google"]);
        expect(requireCapabilityOutput(result, 0)).toEqual({
          kind: "image.description",
          attachmentIndex: 0,
          provider: "google",
          model: "gemini-3-flash-preview",
          text: "google ok",
        });
      },
    );
  });

  it("canonicalizes non-MiniMax active media aliases for auto image resolution", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const cfg = {} as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "google",
      pluginName: "Google Provider",
      source: "test",
      provider: {
        id: "google",
        capabilities: ["image"],
        defaultModels: { image: "gemini-3-flash-preview" },
        describeImage: async () => ({ text: "ok" }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await expect(
        resolveAutoImageModel({
          cfg,
          activeModel: { provider: "gemini", model: "gemini-3-flash-preview" },
        }),
      ).resolves.toEqual({
        provider: "google",
        model: "gemini-3-flash-preview",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("uses active OpenRouter image models for auto image resolution", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const cfg = {} as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "openrouter",
      pluginName: "OpenRouter Provider",
      source: "test",
      provider: {
        id: "openrouter",
        capabilities: ["image"],
        describeImage: async () => ({ text: "ok" }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);
    try {
      await expect(
        resolveAutoImageModel({
          cfg,
          activeModel: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        }),
      ).resolves.toEqual({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("passes workspaceDir to auto image provider auth checks", async () => {
    const modelAuth = await import("../agents/model-auth.js");
    const hasAvailableAuthForProvider = vi.mocked(modelAuth.hasAvailableAuthForProvider);
    hasAvailableAuthForProvider.mockClear();
    hasAvailableAuthForProvider.mockImplementation(
      async (params) => params.workspaceDir === "/tmp/openclaw-workspace",
    );

    try {
      await withMediaFixture(
        {
          filePrefix: "openclaw-image-workspace-auth",
          extension: "png",
          mediaType: "image/png",
          fileContents: Buffer.from("image"),
        },
        async ({ ctx, media, cache }) => {
          const result = await runCapability({
            capability: "image",
            cfg: {} as OpenClawConfig,
            ctx,
            attachments: cache,
            media,
            agentDir: "/tmp/openclaw-agent",
            workspaceDir: "/tmp/openclaw-workspace",
            providerRegistry: new Map([
              [
                "workspace-vision",
                {
                  id: "workspace-vision",
                  capabilities: ["image"],
                  describeImage: async (req) => ({
                    text: "workspace auth ok",
                    model: req.model,
                  }),
                },
              ],
            ]),
            activeModel: { provider: "workspace-vision", model: "vision-v1" },
          });

          expect(result.decision.outcome).toBe("success");
          expect(requireCapabilityOutput(result, 0)).toMatchObject({
            provider: "workspace-vision",
            model: "vision-v1",
            text: "workspace auth ok",
          });
          expect(hasAvailableAuthForProvider).toHaveBeenCalledWith(
            expect.objectContaining({
              provider: "workspace-vision",
              agentDir: "/tmp/openclaw-agent",
              workspaceDir: "/tmp/openclaw-workspace",
            }),
          );
        },
      );
    } finally {
      hasAvailableAuthForProvider.mockImplementation(async () => true);
    }
  });

  it("auto-selects configured OpenRouter image providers with a resolved model", async () => {
    let seenModel: string | undefined;
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-openrouter",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              openrouter: {
                apiKey: "test-openrouter-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "openrouter",
              {
                id: "openrouter",
                capabilities: ["image"],
                describeImage: async (req) => {
                  seenModel = req.model;
                  return { text: "openrouter ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        const output = requireCapabilityOutput(result, 0);
        expect(output.provider).toBe("openrouter");
        expect(output.model).toBe("auto");
        expect(output.text).toBe("openrouter ok");
        expect(seenModel).toBe("auto");
      },
    );
  });

  it("skips configured image providers without an auto-resolvable model", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-custom-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              "custom-image": {
                apiKey: "test-custom-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "custom-image",
              {
                id: "custom-image",
                capabilities: ["image"],
                describeImage: async () => ({ text: "custom ok" }),
              },
            ],
          ]),
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("skipped");
        expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
      },
    );
  });
});
