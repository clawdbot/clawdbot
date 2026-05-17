import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeStickerImage } from "./sticker-cache.js";

const mocks = vi.hoisted(() => {
  const describeImageFileWithModel = vi.fn(async () => ({
    text: "vlm ok",
    model: "MiniMax-VL-01",
  }));
  return {
    describeImageFileWithModel,
    findModelInCatalog: vi.fn((_catalog, provider: string, model: string) => ({
      provider,
      id: model,
      input: ["text", "image"],
    })),
    loadModelCatalog: vi.fn(async () => [
      { provider: "minimax-cn", id: "MiniMax-M2.7", input: ["text", "image"] },
      { provider: "minimax", id: "MiniMax-M2.7", input: ["text", "image"] },
    ]),
    modelSupportsVision: vi.fn((entry: { input?: string[] } | undefined) =>
      Boolean(entry?.input?.includes("image")),
    ),
    resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "minimax-test" })),
    resolveAutoImageModel: vi.fn(async () => ({
      provider: "minimax-cn",
      model: "MiniMax-VL-01",
    })),
    resolveAutoMediaKeyProviders: vi.fn(() => ["minimax-cn", "minimax"]),
    resolveDefaultMediaModel: vi.fn(() => "MiniMax-VL-01"),
    resolveDefaultModelForAgent: vi.fn(() => ({
      provider: "minimax-cn",
      model: "MiniMax-M2.7",
    })),
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  findModelInCatalog: mocks.findModelInCatalog,
  loadModelCatalog: mocks.loadModelCatalog,
  modelSupportsVision: mocks.modelSupportsVision,
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveAutoImageModel: mocks.resolveAutoImageModel,
  resolveAutoMediaKeyProviders: mocks.resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel: mocks.resolveDefaultMediaModel,
}));

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    mediaUnderstanding: {
      describeImageFileWithModel: mocks.describeImageFileWithModel,
    },
  }),
}));

describe("describeStickerImage", () => {
  beforeEach(() => {
    mocks.describeImageFileWithModel.mockClear();
    mocks.findModelInCatalog.mockClear();
    mocks.loadModelCatalog.mockClear();
    mocks.modelSupportsVision.mockClear();
    mocks.resolveApiKeyForProvider.mockClear();
    mocks.resolveAutoImageModel.mockClear();
    mocks.resolveAutoMediaKeyProviders.mockClear();
    mocks.resolveDefaultMediaModel.mockClear();
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("uses MiniMax VLM auto selection instead of legacy chat vision catalog entries", async () => {
    await expect(
      describeStickerImage({
        imagePath: "/tmp/sticker.webp",
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe("vlm ok");

    expect(mocks.resolveDefaultMediaModel).toHaveBeenCalledWith({
      cfg: {},
      providerId: "minimax-cn",
      capability: "image",
      includeConfiguredImageModels: false,
    });
    expect(mocks.resolveAutoImageModel).not.toHaveBeenCalled();
    expect(mocks.describeImageFileWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/sticker.webp",
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
      }),
    );
  });

  it("keeps MiniMax chat defaults on MiniMax VLM when other vision providers are configured", async () => {
    mocks.resolveAutoMediaKeyProviders.mockReturnValue(["openai", "minimax-cn", "minimax"]);
    mocks.loadModelCatalog.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", input: ["text", "image"] },
      { provider: "minimax-cn", id: "MiniMax-M2.7", input: ["text", "image"] },
      { provider: "minimax-cn", id: "MiniMax-VL-01", input: ["image"] },
    ]);

    await expect(
      describeStickerImage({
        imagePath: "/tmp/sticker.webp",
        cfg: {},
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe("vlm ok");

    expect(mocks.describeImageFileWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
      }),
    );
    expect(mocks.describeImageFileWithModel).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
      }),
    );
  });
});
