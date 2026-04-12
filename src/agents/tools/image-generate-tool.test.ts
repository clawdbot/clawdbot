import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let imageGenerationRuntime: typeof import("../../image-generation/runtime.js");
let imageOps: typeof import("../../media/image-ops.js");
let mediaStore: typeof import("../../media/store.js");
let webMedia: typeof import("../../media/web-media.js");
let createImageGenerateTool: typeof import("./image-generate-tool.js").createImageGenerateTool;
let resolveImageGenerationModelConfigForTool: typeof import("./image-generate-tool.js").resolveImageGenerationModelConfigForTool;

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "google",
      defaultModel: "gemini-3.1-flash-image-preview",
      models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
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
  expect(tool).not.toBeNull();
  if (!tool) {
    throw new Error("expected image_generate tool");
  }
  return tool;
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
    mediaStore = await import("../../media/store.js");
    webMedia = await import("../../media/web-media.js");
    ({ createImageGenerateTool, resolveImageGenerationModelConfigForTool } =
      await import("./image-generate-tool.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when no image-generation model can be inferred", () => {
    stubImageGenerationProviders();
    expect(createImageGenerateTool({ config: {} })).toBeNull();
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

    expect(
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
    ).not.toBeNull();
  });

  it("infers an OpenAI image-generation model from env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    expect(resolveImageGenerationModelConfigForTool({ cfg: {} })).toEqual({
      primary: "openai/gpt-image-1",
    });
    expect(createImageGenerateTool({ config: {} })).not.toBeNull();
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

    const tool = createImageGenerateTool({
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
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "A cat wearing sunglasses",
      model: "openai/gpt-image-1",
      filename: "cats/output.png",
      count: 2,
      size: "1024x1024",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        prompt: "A cat wearing sunglasses",
        agentDir: "/tmp/agent",
        modelOverride: "openai/gpt-image-1",
        size: "1024x1024",
        count: 2,
        inputImages: [],
      }),
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("png-1"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("png-2"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Generated 2 images with openai/gpt-image-1."),
        },
      ],
      details: {
        provider: "openai",
        model: "gpt-image-1",
        count: 2,
        media: {
          mediaUrls: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        },
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        filename: "cats/output.png",
        revisedPrompts: ["A more cinematic cat"],
      },
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("MEDIA:/tmp/generated-1.png");
    expect(text).toContain("MEDIA:/tmp/generated-2.png");
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

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "google/gemini-3.1-flash-image-preview" },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-regression", { prompt: "kodo sawaki zazen" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain(
      "MEDIA:/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
    );
    expect(result.details).toMatchObject({
      media: {
        mediaUrls: [
          "/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
        ],
      },
    });
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
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

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

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: undefined,
        resolution: "4K",
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/png",
          }),
        ],
      }),
    );
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

    expect(webMedia.loadWebMedia).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxBytes: undefined }),
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

    await expect(
      tool.execute("call-openai-edit", {
        prompt: "Remove the subject but keep the rest unchanged.",
        image: "./fixtures/reference.png",
      }),
    ).resolves.toBeDefined();

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: undefined,
        resolution: undefined,
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/jpeg",
          }),
        ],
      }),
    );
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

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
        inputImages: expect.arrayContaining([
          expect.objectContaining({ buffer: Buffer.from("input-image"), mimeType: "image/png" }),
        ]),
      }),
    );
    expect(generateImage.mock.calls[0]?.[0].inputImages).toHaveLength(5);
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
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 image with openai/gpt-image-1.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
    );
    expect(result).toMatchObject({
      details: {
        warning: "Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
        ignoredOverrides: [{ key: "aspectRatio", value: "1:1" }],
      },
    });
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

    expect(result.details).toMatchObject({
      aspectRatio: "16:9",
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
    expect(result.details).not.toHaveProperty("size");
  });

  it("rejects unsupported aspect ratios", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-bad-aspect", { prompt: "portrait", aspectRatio: "7:5" }),
    ).rejects.toThrow(
      "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
    );
  });

  it("lists registered provider and model options", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("google (default gemini-3.1-flash-image-preview)");
    expect(text).toContain("gemini-3.1-flash-image-preview");
    expect(text).toContain("gemini-3-pro-image-preview");
    expect(text).toContain("auth: set GEMINI_API_KEY / GOOGLE_API_KEY to use google/*");
    expect(text).toContain("auth: set OPENAI_API_KEY to use openai/*");
    expect(text).toContain("editing up to 5 refs");
    expect(text).toContain("aspect ratios 1:1, 16:9");
    expect(result).toMatchObject({
      details: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "google",
            defaultModel: "gemini-3.1-flash-image-preview",
            authEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            models: expect.arrayContaining([
              "gemini-3.1-flash-image-preview",
              "gemini-3-pro-image-preview",
            ]),
            capabilities: expect.objectContaining({
              edit: expect.objectContaining({
                enabled: true,
                maxInputImages: 5,
              }),
            }),
          }),
          expect.objectContaining({
            id: "openai",
            authEnvVars: ["OPENAI_API_KEY"],
          }),
        ]),
      },
    });
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

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "__proto__/proto-v1",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list-proto", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("__proto__ (default proto-v1)");
    expect(text).not.toContain("auth: set");
    expect(result).toMatchObject({
      details: {
        providers: [expect.objectContaining({ id: "__proto__", authEnvVars: [] })],
      },
    });
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
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
      }),
    );
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for fal/fal-ai/flux/dev: aspectRatio=16:9.",
    );
  });
});
