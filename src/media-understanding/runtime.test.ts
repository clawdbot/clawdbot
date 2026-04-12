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
    });

    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
    expect(mocks.runCapability).not.toHaveBeenCalled();
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
});
