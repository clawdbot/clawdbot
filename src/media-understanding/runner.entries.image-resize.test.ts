import { describe, expect, it, vi } from "vitest";
import { MediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import type { MediaAttachmentCache } from "./attachments.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveImageCompressionModelPolicy: vi.fn(
    async (): Promise<ImageCompressionModelPolicy> => ({
      maxSidePx: 1600,
      preferredSidePx: 1400,
    }),
  ),
}));

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: mocks.resolveImageCompressionModelPolicy,
}));

const { runProviderEntry } = await import("./runner.entries.js");

describe("runProviderEntry image resize boundary", () => {
  it.each(["high" as const, "efficient" as const])(
    "does not apply the image-tool-only $quality preference to a custom provider",
    async (quality) => {
      const source = createSolidPngBuffer(1600, 1200, { r: 24, g: 96, b: 208 });
      const observedDimensions: Array<{ width: number; height: number }> = [];
      const describeImage = vi.fn(async (request: ImageDescriptionRequest) => {
        const dimensions = readImageMetadataFromHeader(request.buffer);
        if (!dimensions) {
          throw new Error("provider received undecodable image bytes");
        }
        observedDimensions.push(dimensions);
        return { text: "described", model: "vision-v1" };
      });
      const getBuffer = vi.fn(async () => ({
        buffer: source,
        fileName: "phone.png",
        mime: "image/png",
        size: source.length,
      }));
      const cfg = { agents: { defaults: { imageQuality: quality } } } as OpenClawConfig;

      await expect(
        runProviderEntry({
          capability: "image",
          entry: { provider: "vision-plugin", model: "vision-v1" },
          cfg,
          ctx: {} as MsgContext,
          attachmentIndex: 0,
          cache: { getBuffer } as unknown as MediaAttachmentCache,
          agentDir: "/tmp/agent",
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
          ]),
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { text: "described", provider: "vision-plugin" },
      });

      expect(getBuffer).toHaveBeenCalledWith({
        attachmentIndex: 0,
        maxBytes: 10 * 1024 * 1024,
        timeoutMs: 60_000,
      });
      expect(describeImage).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.stringMatching(/^phone\.(png|jpg)$/),
          provider: "vision-plugin",
          model: "vision-v1",
        }),
      );
      expect(observedDimensions).toEqual([{ width: 1400, height: 1050 }]);
    },
  );

  it("preserves a configured input cap before optimizer and provider work", async () => {
    const describeImage = vi.fn();
    const getBuffer = vi.fn(async () => {
      throw new MediaUnderstandingSkipError("maxBytes", "Attachment 1 exceeds maxBytes 1048576");
    });
    mocks.resolveImageCompressionModelPolicy.mockClear();

    await expect(
      runProviderEntry({
        capability: "image",
        entry: {
          provider: "vision-plugin",
          model: "vision-v1",
          maxBytes: 1024 * 1024,
        },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: { getBuffer } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
    });

    expect(getBuffer).toHaveBeenCalledWith({
      attachmentIndex: 0,
      maxBytes: 1024 * 1024,
      timeoutMs: 60_000,
    });
    expect(mocks.resolveImageCompressionModelPolicy).not.toHaveBeenCalled();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("maps an irreducible image back to the existing maxBytes skip", async () => {
    const describeImage = vi.fn();

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: {
          getBuffer: vi.fn(async () => ({
            buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
            fileName: "phone.custom",
            mime: "image/x-custom",
            size: 10 * 1024 * 1024 + 1,
          })),
        } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 10485760",
    });
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("reports the stricter model byte cap when optimization rejects an image", async () => {
    const source = Buffer.alloc(10);
    source.write("GIF89a", 0, "ascii");
    source.writeUInt16LE(1, 6);
    source.writeUInt16LE(1, 8);
    const describeImage = vi.fn();
    mocks.resolveImageCompressionModelPolicy.mockResolvedValueOnce({ maxBytes: 8 });

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: {
          getBuffer: vi.fn(async () => ({
            buffer: source,
            fileName: "phone.gif",
            mime: "image/gif",
            size: source.length,
          })),
        } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 8",
    });
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("enforces the selected model byte cap for provider-owned image formats", async () => {
    const source = Buffer.from("custom-image");
    const describeImage = vi.fn(async () => ({ text: "described", model: "vision-v1" }));
    mocks.resolveImageCompressionModelPolicy.mockResolvedValueOnce({ maxBytes: 8 });

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: {
          getBuffer: vi.fn(async () => ({
            buffer: source,
            fileName: "phone.custom",
            mime: "image/x-custom",
            size: source.length,
          })),
        } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 8",
    });
    expect(describeImage).not.toHaveBeenCalled();
  });
});
