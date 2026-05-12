import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaAttachment, MediaUnderstandingOutput } from "../media-understanding/types.js";
import {
  describeImageFile,
  describeImageFileWithModel,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
} from "./runtime.js";

const mocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => {});
  return {
    buildProviderRegistry: vi.fn(() => new Map()),
    createMediaAttachmentCache: vi.fn(() => ({ cleanup })),
    normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(() => []),
    normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
    buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
    getMediaUnderstandingProvider: vi.fn(),
    readLocalFileSafely: vi.fn(async () => ({ buffer: Buffer.from("image") })),
    describeImageWithModel: vi.fn(async () => ({ text: "generic image ok", model: "vision" })),
    runCapability: vi.fn(),
    cleanup,
  };
});

vi.mock("./runner.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  createMediaAttachmentCache: mocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  runCapability: mocks.runCapability,
}));

vi.mock("./provider-registry.js", () => ({
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
}));

vi.mock("../infra/fs-safe.js", () => ({
  readLocalFileSafely: mocks.readLocalFileSafely,
}));

vi.mock("./image-runtime.js", () => ({
  describeImageWithModel: mocks.describeImageWithModel,
}));

function requireRunCapabilityRequest(): unknown {
  const [call] = mocks.runCapability.mock.calls;
  if (!call) {
    throw new Error("expected runCapability call");
  }
  return call[0];
}

describe("media-understanding runtime", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.createMediaAttachmentCache.mockReset();
    mocks.normalizeMediaAttachments.mockReset();
    mocks.normalizeMediaProviderId.mockReset();
    mocks.buildMediaUnderstandingRegistry.mockReset();
    mocks.getMediaUnderstandingProvider.mockReset();
    mocks.readLocalFileSafely.mockReset();
    mocks.readLocalFileSafely.mockResolvedValue({ buffer: Buffer.from("image") });
    mocks.describeImageWithModel.mockReset();
    mocks.describeImageWithModel.mockResolvedValue({ text: "generic image ok", model: "vision" });
    mocks.runCapability.mockReset();
    mocks.cleanup.mockReset();
    mocks.cleanup.mockResolvedValue(undefined);
  });

  it("returns disabled state without loading providers", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);

    await expect(
      runMediaUnderstandingFile({
        capability: "image",
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        cfg: {
          tools: {
            media: {
              image: {
                enabled: false,
              },
            },
          },
        } as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision: { capability: "image", outcome: "disabled", attachments: [] },
    });

    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
    expect(mocks.runCapability).not.toHaveBeenCalled();
  });

  it("preserves skipped decisions when no media provider is available", async () => {
    const decision = {
      capability: "audio" as const,
      outcome: "skipped" as const,
      attachments: [{ attachmentIndex: 0, attempts: [] }],
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision,
    });

    await expect(
      runMediaUnderstandingFile({
        capability: "audio",
        filePath: "/tmp/sample.ogg",
        mime: "audio/ogg",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision,
    });

    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns the matching capability output", async () => {
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "image ok",
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    await expect(
      describeImageFile({
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: "image ok",
      provider: "vision-plugin",
      model: "vision-v1",
      output,
    });

    expect(mocks.runCapability).toHaveBeenCalledTimes(1);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it("passes per-request image prompts into media understanding config", async () => {
    const media = [{ index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" }];
    const providerRegistry = new Map();
    const cache = { cleanup: mocks.cleanup };
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "button count ok",
    };
    mocks.buildProviderRegistry.mockReturnValue(providerRegistry);
    mocks.createMediaAttachmentCache.mockReturnValue(cache);
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    const cfg = {
      tools: {
        media: {
          image: {
            prompt: "default image prompt",
          },
        },
      },
    } as OpenClawConfig;

    await describeImageFile({
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg,
      agentDir: "/tmp/agent",
      prompt: "Count visible buttons",
      timeoutMs: 90_000,
    });

    expect(mocks.runCapability).toHaveBeenCalledOnce();
    expect(requireRunCapabilityRequest()).toEqual({
      capability: "image",
      cfg: {
        tools: {
          media: {
            image: {
              prompt: "Count visible buttons",
              _requestPromptOverride: "Count visible buttons",
              timeoutSeconds: 90,
            },
          },
        },
      },
      ctx: {
        MediaPath: "/tmp/sample.jpg",
        MediaType: "image/jpeg",
      },
      attachments: cache,
      media,
      agentDir: "/tmp/agent",
      providerRegistry,
      config: {
        prompt: "Count visible buttons",
        _requestPromptOverride: "Count visible buttons",
        timeoutSeconds: 90,
      },
      activeModel: undefined,
    });
  });

  it("uses the generic model-backed image runtime for explicit models without media hooks", async () => {
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["zai", { id: "zai", capabilities: ["image"] }]]),
    );

    await expect(
      describeImageFileWithModel({
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        provider: "zai",
        model: "glm-4.6v",
        prompt: "Describe it",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({ text: "generic image ok", model: "vision" });

    expect(mocks.describeImageWithModel).toHaveBeenCalledWith({
      buffer: Buffer.from("image"),
      fileName: "sample.jpg",
      mime: "image/jpeg",
      provider: "zai",
      model: "glm-4.6v",
      prompt: "Describe it",
      maxTokens: undefined,
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/agent",
    });
  });

  it("routes direct image description through a provider-specific image hook", async () => {
    const describeImage = vi.fn(async () => ({
      text: "image ok",
      model: "vision-v1",
    }));
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["gemini", { id: "gemini", capabilities: ["image"], describeImage }]]),
    );
    mocks.readLocalFileSafely.mockResolvedValue({ buffer: Buffer.from("image-bytes") });

    await expect(
      describeImageFileWithModel({
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        provider: "gemini",
        model: "vision-v1",
        prompt: "Describe the sample.",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: "image ok",
      model: "vision-v1",
    });

    expect(mocks.normalizeMediaProviderId).toHaveBeenCalledWith("gemini");
    const [[describeImageOptions]] = describeImage.mock.calls as unknown as Array<
      [
        {
          buffer?: Buffer;
          fileName?: string;
          mime?: string;
          provider?: string;
          model?: string;
          prompt?: string;
          agentDir?: string;
        },
      ]
    >;
    expect(describeImageOptions?.buffer).toEqual(Buffer.from("image-bytes"));
    expect(describeImageOptions?.fileName).toBe("sample.jpg");
    expect(describeImageOptions?.mime).toBe("image/jpeg");
    expect(describeImageOptions?.provider).toBe("gemini");
    expect(describeImageOptions?.model).toBe("vision-v1");
    expect(describeImageOptions?.prompt).toBe("Describe the sample.");
    expect(describeImageOptions?.agentDir).toBe("/tmp/agent");
  });

  it("routes structured extraction to a provider by id and model", async () => {
    const providerRegistry = new Map();
    const authStore = {} as AuthProfileStore;
    const extractStructured = vi.fn(async () => ({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json" as const,
    }));
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin", extractStructured });

    await expect(
      extractStructuredWithModel({
        input: [
          { type: "text", text: "Extract the fact." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "Vision-Plugin",
        model: "vision-json",
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
        timeoutMs: 45_000,
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json",
    });

    expect(mocks.buildMediaUnderstandingRegistry).toHaveBeenCalledWith(undefined, {});
    expect(mocks.getMediaUnderstandingProvider).toHaveBeenCalledWith(
      "Vision-Plugin",
      providerRegistry,
    );
    const [[extractOptions]] = extractStructured.mock.calls as unknown as Array<
      [
        {
          input?: unknown;
          instructions?: string;
          provider?: string;
          model?: string;
          profile?: string;
          preferredProfile?: string;
          authStore?: AuthProfileStore;
          timeoutMs?: number;
          agentDir?: string;
        },
      ]
    >;
    expect(extractOptions?.input).toEqual([
      { type: "text", text: "Extract the fact." },
      {
        type: "image",
        buffer: Buffer.from("image-bytes"),
        fileName: "fact.png",
        mime: "image/png",
      },
    ]);
    expect(extractOptions?.instructions).toBe("Return JSON.");
    expect(extractOptions?.provider).toBe("Vision-Plugin");
    expect(extractOptions?.model).toBe("vision-json");
    expect(extractOptions?.profile).toBe("work");
    expect(extractOptions?.preferredProfile).toBe("preferred-work");
    expect(extractOptions?.authStore).toBe(authStore);
    expect(extractOptions?.timeoutMs).toBe(45_000);
    expect(extractOptions?.agentDir).toBe("/tmp/agent");
  });

  it("rejects text-only structured extraction before provider lookup", async () => {
    await expect(
      extractStructuredWithModel({
        input: [{ type: "text", text: "Extract the fact." }],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Structured extraction requires at least one image input.");

    expect(mocks.buildMediaUnderstandingRegistry).not.toHaveBeenCalled();
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("fails clearly when a provider lacks structured extraction", async () => {
    const providerRegistry = new Map();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin" });

    await expect(
      extractStructuredWithModel({
        input: [
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Provider does not support structured extraction: vision-plugin");
  });

  it("surfaces the underlying provider failure when media understanding fails", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: {
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                outcome: "failed",
                reason: "Error: Audio transcription response missing text",
              },
            ],
          },
        ],
      },
    });

    await expect(
      runMediaUnderstandingFile({
        capability: "audio",
        filePath: "/tmp/sample.ogg",
        mime: "audio/ogg",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).rejects.toThrow("Audio transcription response missing text");

    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
});
