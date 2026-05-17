import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const taskRuntimeMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
}));

vi.mock("../../tasks/detached-task-runtime.js", () => taskRuntimeMocks);

let imageGenerationRuntime: typeof import("../../image-generation/runtime.js");
let imageOps: typeof import("../../media/image-ops.js");
let splitMediaFromOutput: typeof import("../../media/parse.js").splitMediaFromOutput;
let mediaStore: typeof import("../../media/store.js");
let webMedia: typeof import("../../media/web-media.js");
let createImageGenerateTool: typeof import("./image-generate-tool.js").createImageGenerateTool;
let resolveImageGenerationModelConfigForTool: typeof import("./image-generate-tool.js").resolveImageGenerationModelConfigForTool;

const GENERATION_PROVIDER_ENV_VARS = [
  "BYTEPLUS_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPINFRA_API_KEY",
  "FAL_API_KEY",
  "FAL_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "GOOGLE_API_KEYS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "LITELLM_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "MODELSTUDIO_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENROUTER_API_KEY",
  "QWEN_API_KEY",
  "RUNWAY_API_KEY",
  "RUNWAYML_API_SECRET",
  "TOGETHER_API_KEY",
  "VYDRA_API_KEY",
  "XAI_API_KEY",
];

function hasStubbedImageProviderAuth(providerId: string): boolean {
  if (providerId === "openai") {
    return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEYS?.trim());
  }
  if (providerId === "google") {
    return Boolean(
      process.env.GEMINI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEYS?.trim() ||
      process.env.GOOGLE_API_KEY?.trim() ||
      process.env.GOOGLE_API_KEYS?.trim(),
    );
  }
  return false;
}

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "google",
      defaultModel: "gemini-3.1-flash-image-preview",
      models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
      isConfigured: () => hasStubbedImageProviderAuth("google"),
      capabilities: {
        generate: {
          maxCount: 4,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        edit: {
          enabled: true,
          maxInputImages: 5,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        geometry: {
          resolutions: ["1K", "2K", "4K"],
          aspectRatios: ["1:1", "16:9"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      isConfigured: () => hasStubbedImageProviderAuth("openai"),
      capabilities: {
        generate: {
          maxCount: 4,
          supportsSize: true,
          supportsAspectRatio: true,
        },
        edit: {
          enabled: false,
          maxInputImages: 0,
        },
        geometry: {
          sizes: ["1024x1024", "1024x1536", "1536x1024"],
          aspectRatios: ["1:1", "16:9"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

function requireImageGenerateTool(tool: ReturnType<typeof createImageGenerateTool>) {
  expect(typeof tool?.execute).toBe("function");
  if (!tool) {
    throw new Error("expected image_generate tool");
  }
  return tool;
}

type UnknownMock = { mock: { calls: unknown[][] } };

function mockCallArg(
  mock: unknown,
  index: number,
  label: string,
  argIndex = 0,
): Record<string, unknown> {
  const calls = (mock as UnknownMock).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} to be a mock`);
  }
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call[argIndex] as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

type ImageGenerateTool = NonNullable<ReturnType<typeof createImageGenerateTool>>;
type ToolResult = Awaited<ReturnType<ImageGenerateTool["execute"]>>;

function resultDetails(result: ToolResult): Record<string, unknown> {
  return requireRecord(result.details, "tool result details");
}

function resultText(result: ToolResult): string {
  return (result.content?.[0] as { text: string } | undefined)?.text ?? "";
}

function ensureDefaultImageGenerationProvidersStubbed() {
  if (vi.isMockFunction(imageGenerationRuntime.listRuntimeImageGenerationProviders)) {
    return;
  }
  stubImageGenerationProviders();
}

function createToolWithPrimaryImageModel(
  primary: string,
  extra?: {
    agentDir?: string;
    workspaceDir?: string;
  },
) {
  ensureDefaultImageGenerationProvidersStubbed();
  return requireImageGenerateTool(
    createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary,
            },
          },
        },
      },
      ...extra,
    }),
  );
}

function stubEditedImageFlow(params?: { width?: number; height?: number }) {
  const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
    provider: "google",
    model: "gemini-3-pro-image-preview",
    attempts: [],
    ignoredOverrides: [],
    images: [
      {
        buffer: Buffer.from("png-out"),
        mimeType: "image/png",
        fileName: "edited.png",
      },
    ],
  });
  vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
    kind: "image",
    buffer: Buffer.from("input-image"),
    contentType: "image/png",
  });
  if (params?.width && params?.height) {
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      width: params.width,
      height: params.height,
    });
  }
  vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
    path: "/tmp/edited.png",
    id: "edited.png",
    size: 7,
    contentType: "image/png",
  });
  return generateImage;
}

function createFalEditProvider(params?: {
  maxInputImages?: number;
  supportsAspectRatio?: boolean;
  aspectRatios?: string[];
}) {
  return {
    id: "fal",
    defaultModel: "fal-ai/flux/dev",
    models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxInputImages: params?.maxInputImages ?? 1,
        supportsSize: true,
        supportsAspectRatio: params?.supportsAspectRatio ?? false,
        supportsResolution: true,
      },
      ...(params?.aspectRatios
        ? {
            geometry: {
              aspectRatios: params.aspectRatios,
            },
          }
        : {}),
    },
    generateImage: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

describe("createImageGenerateTool", () => {
  beforeAll(async () => {
    vi.doMock("../../secrets/provider-env-vars.js", async () => {
      const actual = await vi.importActual<typeof import("../../secrets/provider-env-vars.js")>(
        "../../secrets/provider-env-vars.js",
      );
      return {
        ...actual,
        getProviderEnvVars: (providerId: string) => {
          if (providerId === "google") {
            return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
          }
          if (providerId === "openai") {
            return ["OPENAI_API_KEY"];
          }
          return [];
        },
      };
    });
    imageGenerationRuntime = await import("../../image-generation/runtime.js");
    imageOps = await import("../../media/image-ops.js");
    ({ splitMediaFromOutput } = await import("../../media/parse.js"));
    mediaStore = await import("../../media/store.js");
    webMedia = await import("../../media/web-media.js");
    ({ createImageGenerateTool, resolveImageGenerationModelConfigForTool } =
      await import("./image-generate-tool.js"));
  });

  beforeEach(() => {
    for (const envVar of GENERATION_PROVIDER_ENV_VARS) {
      vi.stubEnv(envVar, "");
    }
    taskRuntimeMocks.createRunningTaskRun.mockReset();
    taskRuntimeMocks.recordTaskRunProgressByRunId.mockReset();
    taskRuntimeMocks.completeTaskRunByRunId.mockReset();
    taskRuntimeMocks.failTaskRunByRunId.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when no image-generation model can be inferred", () => {
    stubImageGenerationProviders();
    expect(createImageGenerateTool({ config: {} })).toBeNull();
  });

  it("tells agents how to request transparent OpenAI backgrounds", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    stubImageGenerationProviders();

    const tool = requireImageGenerateTool(createImageGenerateTool({ config: {} }));

    expect(tool.description).toContain('outputFormat="png" or "webp"');
    expect(tool.description).toContain('background="transparent"');
    expect(tool.description).toContain("openai.background");
    expect(tool.description).toContain("gpt-image-1.5");
    expect(JSON.stringify(tool.parameters)).toContain("openai/gpt-image-1.5");
  });

  it("does not load runtime providers while registering an explicitly configured tool", () => {
    const listProviders = vi
      .spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders")
      .mockImplementation(() => {
        throw new Error("runtime provider list should not run during tool registration");
      });

    requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
      }),
    );
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("matches image-generation providers across canonical provider aliases", () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "z.ai",
        aliases: ["z-ai"],
        defaultModel: "glm-4.5-image",
        models: ["glm-4.5-image"],
        capabilities: {
          generate: {
            maxCount: 4,
          },
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
          geometry: {},
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "z-ai/glm-4.5-image",
              },
            },
          },
        },
      }),
    );
  });

  it("infers an OpenAI image-generation model from env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    expect(resolveImageGenerationModelConfigForTool({ cfg: {} })).toEqual({
      primary: "openai/gpt-image-1",
    });
    requireImageGenerateTool(createImageGenerateTool({ config: {} }));
  });

  it("does not load runtime providers while resolving an explicitly configured model", () => {
    const listProviders = vi
      .spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders")
      .mockImplementation(() => {
        throw new Error("runtime provider list should not run for explicit image model config");
      });

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
      }),
    ).toEqual({ primary: "openai/gpt-image-1" });
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("infers the canonical OpenAI image model from provider readiness without explicit config", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const isConfigured = vi.fn(({ agentDir }: { agentDir?: string }) => agentDir === "/tmp/agent");
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-2",
        models: ["gpt-image-2"],
        isConfigured,
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 5,
            supportsSize: true,
          },
          geometry: {
            sizes: ["1024x1024", "1536x1024", "1024x1536"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).toEqual({
      primary: "openai/gpt-image-2",
    });
    requireImageGenerateTool(createImageGenerateTool({ config: {}, agentDir: "/tmp/agent" }));
    expect(isConfigured).toHaveBeenCalledWith({
      cfg: {},
      agentDir: "/tmp/agent",
    });
  });

  it("prefers OpenAI image generation when the default model uses its Codex provider alias", () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "fal",
        defaultModel: "fal-ai/flux/dev",
        models: ["fal-ai/flux/dev"],
        isConfigured: () => true,
        capabilities: {
          generate: { maxCount: 4 },
          edit: { enabled: true, maxInputImages: 1 },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
      {
        id: "openai",
        aliases: ["openai-codex"],
        defaultModel: "gpt-image-2",
        models: ["gpt-image-2"],
        isConfigured: () => true,
        capabilities: {
          generate: { maxCount: 4 },
          edit: { enabled: true, maxInputImages: 5 },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openai-codex/gpt-5.5",
              },
            },
          },
        },
      }),
    ).toEqual({
      primary: "openai/gpt-image-2",
      fallbacks: ["fal/fal-ai/flux/dev"],
    });
  });

  it("prefers the primary model provider when multiple image providers have auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test");

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "google/gemini-3.1-pro-preview",
              },
            },
          },
        },
      }),
    ).toEqual({
      primary: "google/gemini-3.1-flash-image-preview",
      fallbacks: ["openai/gpt-image-1"],
    });
  });

  it("generates images and returns details.media paths", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        models: ["gpt-image-1"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: true,
          },
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
            aspectRatios: ["1:1", "16:9"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-1"),
          mimeType: "image/png",
          fileName: "cat-one.png",
        },
        {
          buffer: Buffer.from("png-2"),
          mimeType: "image/png",
          fileName: "cat-two.png",
          revisedPrompt: "A more cinematic cat",
        },
      ],
    });
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-1.png",
      id: "generated-1.png",
      size: 5,
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-2.png",
      id: "generated-2.png",
      size: 5,
      contentType: "image/png",
    });

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              mediaMaxMb: 8,
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        agentDir: "/tmp/agent",
      }),
    );

    const result = await tool.execute("call-1", {
      prompt: "A cat wearing sunglasses",
      model: "openai/gpt-image-1",
      filename: "cats/output.png",
      count: 2,
      size: "1024x1024",
    });

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    expect(generateArgs.cfg).toEqual({
      agents: {
        defaults: {
          mediaMaxMb: 8,
          imageGenerationModel: {
            primary: "openai/gpt-image-1",
          },
        },
      },
    });
    expect(generateArgs.prompt).toBe("A cat wearing sunglasses");
    expect(generateArgs.agentDir).toBe("/tmp/agent");
    expect(generateArgs.modelOverride).toBe("openai/gpt-image-1");
    expect(generateArgs.size).toBe("1024x1024");
    expect(generateArgs.count).toBe(2);
    expect(generateArgs.inputImages).toEqual([]);
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("png-1"),
      "image/png",
      "tool-image-generation",
      8 * 1024 * 1024,
      "cats/output.png",
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("png-2"),
      "image/png",
      "tool-image-generation",
      8 * 1024 * 1024,
      "cats/output.png",
    );
    const text = resultText(result);
    expect(text).toContain("Generated 2 images with openai/gpt-image-1.");
    const details = resultDetails(result);
    const media = requireRecord(details.media, "media details");
    expect(details.provider).toBe("openai");
    expect(details.model).toBe("gpt-image-1");
    expect(details.count).toBe(2);
    expect(media.mediaUrls).toEqual(["/tmp/generated-1.png", "/tmp/generated-2.png"]);
    expect(details.paths).toEqual(["/tmp/generated-1.png", "/tmp/generated-2.png"]);
    expect(details.filename).toBe("cats/output.png");
    expect(details.revisedPrompts).toEqual(["A more cinematic cat"]);
    expect(text).toContain('path="/tmp/generated-1.png"');
    expect(text).toContain('path="/tmp/generated-2.png"');
    expect(text).not.toMatch(/^MEDIA:/m);
  });

  it("starts image generation asynchronously when a session delivery context is available", async () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "cat.png",
        },
      ],
    });
    taskRuntimeMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-image-123",
    });
    const scheduled: Array<() => Promise<void>> = [];
    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        agentDir: "/tmp/agent",
        agentSessionKey: "agent:main:discord:direct:123",
        requesterOrigin: {
          channel: "discord",
          to: "dm:123",
        },
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
      }),
    );

    const result = await tool.execute("call-async", {
      prompt: "A cat wearing sunglasses",
      model: "openai/gpt-image-1",
    });

    expect(generateImage).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(resultText(result)).toContain("Background task started for image generation");
    const details = resultDetails(result);
    expect(details.async).toBe(true);
    expect(details.status).toBe("started");
    expect(details.taskId).toBe("task-image-123");
    expect(taskRuntimeMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskKind: "image_generation",
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main:discord:direct:123",
        progressSummary: "Queued image generation",
      }),
    );
  });

  it("uses configured timeoutMs for image generation and lets calls override it", async () => {
    stubImageGenerationProviders();
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "cat.png",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.png",
      id: "generated.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
                timeoutMs: 180_000,
              },
            },
          },
        },
      }),
    );

    const defaultResult = await tool.execute("call-timeout-default", {
      prompt: "A cat wearing sunglasses",
    });
    const overrideResult = await tool.execute("call-timeout-override", {
      prompt: "A cat wearing sunglasses",
      timeoutMs: 12_345,
    });

    expect(mockCallArg(generateImage, 0, "generateImage").timeoutMs).toBe(180_000);
    expect(mockCallArg(generateImage, 1, "generateImage").timeoutMs).toBe(12_345);
    expect(resultDetails(defaultResult).timeoutMs).toBe(180_000);
    expect(resultDetails(overrideResult).timeoutMs).toBe(12_345);
  });

  it("forwards output hints and OpenAI provider options", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-2",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("jpg-out"),
          mimeType: "image/jpeg",
          fileName: "preview.jpg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.jpg",
      id: "generated.jpg",
      size: 5,
      contentType: "image/jpeg",
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-2");
    const result = await tool.execute("call-openai-hints", {
      prompt: "Cheap preview",
      quality: "low",
      outputFormat: "jpeg",
      openai: {
        background: "opaque",
        moderation: "low",
        outputCompression: 60,
        user: "end-user-42",
      },
    });

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    expect(generateArgs.quality).toBe("low");
    expect(generateArgs.outputFormat).toBe("jpeg");
    expect(generateArgs.providerOptions).toEqual({
      openai: {
        background: "opaque",
        moderation: "low",
        outputCompression: 60,
        user: "end-user-42",
      },
    });
    const details = resultDetails(result);
    expect(details.quality).toBe("low");
    expect(details.outputFormat).toBe("jpeg");
  });

  it("forwards transparent OpenAI background requests with a PNG output format", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1.5",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "transparent.png",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/transparent.png",
      id: "transparent.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1.5");
    const result = await tool.execute("call-openai-transparent", {
      prompt: "A transparent badge",
      outputFormat: "png",
      openai: {
        background: "transparent",
      },
    });

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    const cfg = requireRecord(generateArgs.cfg, "generateImage config");
    const agents = requireRecord(cfg.agents, "generateImage agents config");
    const defaults = requireRecord(agents.defaults, "generateImage defaults config");
    expect(defaults.imageGenerationModel).toEqual({ primary: "openai/gpt-image-1.5" });
    expect(generateArgs.outputFormat).toBe("png");
    expect(generateArgs.providerOptions).toEqual({
      openai: {
        background: "transparent",
      },
    });
    const details = resultDetails(result);
    expect(details.provider).toBe("openai");
    expect(details.model).toBe("gpt-image-1.5");
    expect(details.outputFormat).toBe("png");
  });

  it("includes MEDIA paths in content text so follow-up replies use the real saved file", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "google",
        defaultModel: "gemini-3.1-flash-image-preview",
        models: ["gemini-3.1-flash-image-preview"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 5,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          geometry: {
            resolutions: ["1K", "2K", "4K"],
            aspectRatios: ["1:1", "16:9"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          mimeType: "image/jpeg",
          fileName: "kodo_sawaki_zazen.jpg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
      id: "kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
      size: 8,
      contentType: "image/jpeg",
    });

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: { primary: "google/gemini-3.1-flash-image-preview" },
            },
          },
        },
      }),
    );

    const result = await tool.execute("call-regression", { prompt: "kodo sawaki zazen" });
    const text = resultText(result);

    expect(text).toContain(
      'path="/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg"',
    );
    const details = resultDetails(result);
    const media = requireRecord(details.media, "media details");
    expect(media.mediaUrls).toEqual([
      "/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
    ]);
  });

  it("rejects counts outside the supported range", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "google",
        defaultModel: "gemini-3.1-flash-image-preview",
        models: ["gemini-3.1-flash-image-preview"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 5,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          geometry: {
            resolutions: ["1K", "2K", "4K"],
            aspectRatios: ["1:1", "16:9"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "google/gemini-3.1-flash-image-preview",
              },
            },
          },
        },
      }),
    );

    await expect(tool.execute("call-2", { prompt: "too many cats", count: 5 })).rejects.toThrow(
      "count must be between 1 and 4",
    );
  });

  it("forwards reference images and inferred resolution for edit mode", async () => {
    const generateImage = stubEditedImageFlow({ width: 3200, height: 1800 });
    const tool = createToolWithPrimaryImageModel("google/gemini-3-pro-image-preview", {
      workspaceDir: process.cwd(),
    });

    await tool.execute("call-edit", {
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
      image: "./fixtures/reference.png",
    });

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    expect(generateArgs.aspectRatio).toBeUndefined();
    expect(generateArgs.resolution).toBe("4K");
    expect(generateArgs.inputImages).toEqual([
      {
        buffer: Buffer.from("input-image"),
        mimeType: "image/png",
      },
    ]);
  });

  it("accepts managed inbound reference images for edit mode", async () => {
    stubEditedImageFlow({ width: 1024, height: 1024 });
    const tool = createToolWithPrimaryImageModel("google/gemini-3-pro-image-preview", {
      workspaceDir: process.cwd(),
    });

    await tool.execute("call-edit-managed", {
      prompt: "Use this reference.",
      image: "media://inbound/reference.png",
    });

    const loadArgs = mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 1);
    expect(mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 0)).toBe(
      "media://inbound/reference.png",
    );
    if (!loadArgs || typeof loadArgs !== "object") {
      throw new Error("expected loadWebMedia options");
    }
  });

  it("passes web_fetch SSRF policy to remote reference images", async () => {
    stubImageGenerationProviders();
    const generateImage = stubEditedImageFlow({ width: 1024, height: 1024 });
    const defaultTool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: { imageGenerationModel: { primary: "google/gemini-3-pro-image-preview" } },
          },
        },
        workspaceDir: process.cwd(),
      }),
    );

    await defaultTool.execute("call-edit-rfc2544-default", {
      prompt: "Use this reference.",
      image: "http://198.18.0.153/reference.png",
    });
    const defaultLoadUrl = mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 0);
    const defaultLoadOptions = mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 1);
    expect(defaultLoadUrl).toBe("http://198.18.0.153/reference.png");
    expect(requireRecord(defaultLoadOptions, "loadWebMedia options").ssrfPolicy).toBeUndefined();

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: { imageGenerationModel: { primary: "google/gemini-3-pro-image-preview" } },
          },
          tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
        },
        workspaceDir: process.cwd(),
      }),
    );

    await tool.execute("call-edit-rfc2544", {
      prompt: "Use this reference.",
      image: "http://198.18.0.153/reference.png",
    });

    const configuredLoadUrl = mockCallArg(webMedia.loadWebMedia, 1, "loadWebMedia", 0);
    const configuredLoadOptions = mockCallArg(webMedia.loadWebMedia, 1, "loadWebMedia", 1);
    expect(configuredLoadUrl).toBe("http://198.18.0.153/reference.png");
    expect(requireRecord(configuredLoadOptions, "loadWebMedia options").ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
    });
    expect(mockCallArg(generateImage, 1, "generateImage").ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("ignores non-finite mediaMaxMb when loading reference images", async () => {
    stubImageGenerationProviders();
    stubEditedImageFlow({ width: 3200, height: 1800 });
    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "google/gemini-3-pro-image-preview",
              },
              mediaMaxMb: Number.POSITIVE_INFINITY,
            },
          },
        },
        workspaceDir: process.cwd(),
      }),
    );

    await tool.execute("call-edit-infinity-cap", {
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
      image: "./fixtures/reference.png",
    });

    expect(typeof mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 0)).toBe("string");
    expect(mockCallArg(webMedia.loadWebMedia, 0, "loadWebMedia", 1)).toHaveProperty(
      "maxBytes",
      undefined,
    );
  });

  it("does not treat inferred edit resolution as an OpenAI override", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        models: ["gpt-image-1"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          edit: {
            enabled: true,
            maxCount: 4,
            maxInputImages: 5,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/jpeg",
    });
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      width: 3200,
      height: 1800,
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1", {
      workspaceDir: process.cwd(),
    });

    const result = await tool.execute("call-openai-edit", {
      prompt: "Remove the subject but keep the rest unchanged.",
      image: "./fixtures/reference.png",
    });
    const details = resultDetails(result);
    expect(details.provider).toBe("openai");
    expect(details.model).toBe("gpt-image-1");

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    expect(generateArgs.modelOverride).toBeUndefined();
    expect(generateArgs.resolution).toBeUndefined();
    expect(generateArgs.inputImages).toEqual([
      {
        buffer: Buffer.from("input-image"),
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("forwards explicit aspect ratio and supports up to 5 reference images", async () => {
    const generateImage = stubEditedImageFlow();
    const tool = createToolWithPrimaryImageModel("google/gemini-3-pro-image-preview", {
      workspaceDir: process.cwd(),
    });

    const images = Array.from({ length: 5 }, (_, index) => `./fixtures/ref-${index + 1}.png`);
    await tool.execute("call-compose", {
      prompt: "Combine these into one scene",
      images,
      aspectRatio: "16:9",
    });

    const generateArgs = mockCallArg(generateImage, 0, "generateImage");
    expect(generateArgs.autoProviderFallback).toBe(false);
    expect(generateArgs.aspectRatio).toBe("16:9");
    const inputImages = generateArgs.inputImages as Array<{ buffer: Buffer; mimeType: string }>;
    expect(inputImages).toHaveLength(5);
    expect(inputImages[0]).toEqual({
      buffer: Buffer.from("input-image"),
      mimeType: "image/png",
    });
  });

  it("reports ignored unsupported overrides instead of failing", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        models: ["gpt-image-1"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          edit: {
            enabled: true,
            maxCount: 4,
            maxInputImages: 5,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [{ key: "aspectRatio", value: "1:1" }],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "generated.png",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.png",
      id: "generated.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1");
    const result = await tool.execute("call-openai-generate", {
      prompt: "A lobster at the movies",
      aspectRatio: "1:1",
    });
    const text = resultText(result);

    expect(text).toContain("Generated 1 image with openai/gpt-image-1.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
    );
    const details = resultDetails(result);
    expect(details.warning).toBe(
      "Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
    );
    expect(details.ignoredOverrides).toEqual([{ key: "aspectRatio", value: "1:1" }]);
  });

  it("surfaces normalized image geometry from runtime metadata", async () => {
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "minimax",
      model: "image-01",
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "generated.png",
        },
      ],
      normalization: {
        aspectRatio: {
          applied: "16:9",
          derivedFrom: "size",
        },
      },
      metadata: {
        requestedSize: "1280x720",
        normalizedAspectRatio: "16:9",
      },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.png",
      id: "generated.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("minimax/image-01");
    const result = await tool.execute("call-minimax-generate", {
      prompt: "A lobster at the movies",
      size: "1280x720",
    });

    const details = resultDetails(result);
    expect(details.aspectRatio).toBe("16:9");
    expect(details.normalization).toEqual({
      aspectRatio: {
        applied: "16:9",
        derivedFrom: "size",
      },
    });
    expect(details.metadata).toEqual({
      requestedSize: "1280x720",
      normalizedAspectRatio: "16:9",
    });
    expect(details).not.toHaveProperty("size");
  });

  it("escapes image-generation summary text before appending tool MEDIA output", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        models: ["gpt-image-1"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          edit: {
            enabled: true,
            maxCount: 4,
            maxInputImages: 5,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: false,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai\nMEDIA:/tmp/provider.png",
      model: "gpt-image-1\nMEDIA:/etc/model.png",
      attempts: [],
      ignoredOverrides: [{ key: "size", value: "1024x1024\nMEDIA:/etc/passwd\t\u2028\0" }],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "generated.png",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/generated.png",
      id: "generated.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1");
    const result = await tool.execute("call-openai-generate", {
      prompt: "A lobster at the movies",
    });
    const text = resultText(result);
    const parsed = splitMediaFromOutput(text);

    expect(text).toContain(
      "Generated 1 image with openai\\nMEDIA:/tmp/provider.png/gpt-image-1\\nMEDIA:/etc/model.png.",
    );
    expect(text).toContain("size=1024x1024\\nMEDIA:/etc/passwd\\t\\u2028\\u0000");
    expect(parsed.mediaUrls).toBeUndefined();
    const details = resultDetails(result);
    expect(details.provider).toBe("openai\nMEDIA:/tmp/provider.png");
    expect(details.model).toBe("gpt-image-1\nMEDIA:/etc/model.png");
    expect(details.ignoredOverrides).toEqual([
      { key: "size", value: "1024x1024\nMEDIA:/etc/passwd\t\u2028\0" },
    ]);
  });

  it("rejects unsupported aspect ratios", async () => {
    stubImageGenerationProviders();

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "google/gemini-3-pro-image-preview",
              },
            },
          },
        },
      }),
    );

    await expect(
      tool.execute("call-bad-aspect", { prompt: "portrait", aspectRatio: "7:5" }),
    ).rejects.toThrow(
      "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
    );
  });

  it("lists registered provider and model options", async () => {
    stubImageGenerationProviders();

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "google/gemini-3.1-flash-image-preview",
              },
            },
          },
        },
      }),
    );

    const result = await tool.execute("call-list", { action: "list" });
    const text = resultText(result);

    expect(text).toContain("google (default gemini-3.1-flash-image-preview)");
    expect(text).toContain("gemini-3.1-flash-image-preview");
    expect(text).toContain("gemini-3-pro-image-preview");
    expect(text).toContain("auth: set GEMINI_API_KEY / GOOGLE_API_KEY to use google/*");
    expect(text).toContain(
      "auth: set OPENAI_API_KEY or configure OpenAI Codex OAuth for openai/gpt-image-2",
    );
    expect(text).toContain("editing up to 5 refs");
    expect(text).toContain("aspect ratios 1:1, 16:9");
    const details = resultDetails(result);
    const providers = details.providers as Array<Record<string, unknown>>;
    const googleProvider = providers.find((provider) => provider.id === "google");
    const openaiProvider = providers.find((provider) => provider.id === "openai");
    if (!googleProvider || !openaiProvider) {
      throw new Error("Expected google and openai provider details");
    }
    expect(googleProvider.defaultModel).toBe("gemini-3.1-flash-image-preview");
    expect(googleProvider.authEnvVars).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(googleProvider.models).toEqual([
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
    ]);
    const googleCapabilities = requireRecord(googleProvider.capabilities, "google capabilities");
    expect(googleCapabilities.edit).toEqual({
      enabled: true,
      maxInputImages: 5,
      supportsAspectRatio: true,
      supportsResolution: true,
    });
    expect(openaiProvider.authEnvVars).toEqual(["OPENAI_API_KEY"]);
  });

  it("skips auth hints for prototype-like provider ids", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "__proto__",
        defaultModel: "proto-v1",
        models: ["proto-v1"],
        capabilities: {
          generate: {
            maxCount: 1,
          },
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "__proto__/proto-v1",
              },
            },
          },
        },
      }),
    );

    const result = await tool.execute("call-list-proto", { action: "list" });
    const text = resultText(result);

    expect(text).toContain("__proto__ (default proto-v1)");
    expect(text).not.toContain("auth: set");
    const details = resultDetails(result);
    const providers = details.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("__proto__");
    expect(providers[0]?.authEnvVars).toEqual([]);
  });

  it("rejects provider-specific edit limits before runtime", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      createFalEditProvider(),
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("fal/fal-ai/flux/dev", {
      workspaceDir: process.cwd(),
    });

    await expect(
      tool.execute("call-fal-edit", {
        prompt: "combine",
        images: ["./fixtures/a.png", "./fixtures/b.png"],
      }),
    ).rejects.toThrow("fal edit supports at most 1 reference image");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("uses registered provider metadata for slash-containing model overrides", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      createFalEditProvider(),
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("fal/fal-ai/flux/dev", {
      workspaceDir: process.cwd(),
    });

    await expect(
      tool.execute("call-fal-model-only-edit", {
        prompt: "combine",
        model: "fal-ai/flux/dev",
        images: ["./fixtures/a.png", "./fixtures/b.png"],
      }),
    ).rejects.toThrow("fal edit supports at most 1 reference image");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("passes edit aspect ratio overrides through to runtime for provider-level handling", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      createFalEditProvider({ aspectRatios: ["1:1", "16:9"] }),
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "fal",
      model: "fal-ai/flux/dev",
      attempts: [],
      ignoredOverrides: [{ key: "aspectRatio", value: "16:9" }],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createToolWithPrimaryImageModel("fal/fal-ai/flux/dev", {
      workspaceDir: process.cwd(),
    });

    const result = await tool.execute("call-fal-aspect", {
      prompt: "edit",
      image: "./fixtures/a.png",
      aspectRatio: "16:9",
    });
    const text = resultText(result);

    expect(mockCallArg(generateImage, 0, "generateImage").aspectRatio).toBe("16:9");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for fal/fal-ai/flux/dev: aspectRatio=16:9.",
    );
  });
});
