import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaAttachment, MediaUnderstandingOutput } from "../media-understanding/types.js";
import { describeImageFile, runMediaUnderstandingFile } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => {});
  return {
    buildProviderRegistry: vi.fn(() => new Map()),
    createMediaAttachmentCache: vi.fn(() => ({ cleanup })),
    normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(() => []),
    normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
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
}));

describe("media-understanding runtime", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.createMediaAttachmentCache.mockReset();
    mocks.normalizeMediaAttachments.mockReset();
    mocks.normalizeMediaProviderId.mockReset();
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
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "button count ok",
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    await describeImageFile({
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg: {
        tools: {
          media: {
            image: {
              prompt: "default image prompt",
            },
          },
        },
      } as OpenClawConfig,
      agentDir: "/tmp/agent",
      prompt: "Count visible buttons",
      timeoutMs: 90_000,
    });

    expect(mocks.runCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          prompt: "Count visible buttons",
          _requestPromptOverride: "Count visible buttons",
          timeoutSeconds: 90,
        }),
      }),
    );
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
