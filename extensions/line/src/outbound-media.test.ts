import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

import {
  detectLineMediaKind,
  resolveLineOutboundMedia,
  validateLineMediaUrl,
} from "./outbound-media.js";

describe("validateLineMediaUrl", () => {
  beforeEach(() => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
  });

  it("accepts HTTPS URL", async () => {
    await expect(validateLineMediaUrl("https://example.com/image.jpg")).resolves.toBeUndefined();
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("accepts uppercase HTTPS scheme", async () => {
    await expect(validateLineMediaUrl("HTTPS://EXAMPLE.COM/img.jpg")).resolves.toBeUndefined();
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("rejects HTTP URL", async () => {
    await expect(validateLineMediaUrl("http://example.com/image.jpg")).rejects.toThrow(
      /must use HTTPS/i,
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects URL longer than 2000 chars", async () => {
    const longUrl = `https://example.com/${"a".repeat(1981)}`;
    expect(longUrl.length).toBeGreaterThan(2000);
    await expect(validateLineMediaUrl(longUrl)).rejects.toThrow(/2000 chars or less/i);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects private-network targets through the shared SSRF policy", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("SSRF blocked private network target"),
    );

    await expect(validateLineMediaUrl("https://127.0.0.1/image.jpg")).rejects.toThrow(
      /private network/i,
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("127.0.0.1", {
      policy: { allowPrivateNetwork: false },
    });
  });
});

describe("detectLineMediaKind", () => {
  it("maps image MIME to image", () => {
    expect(detectLineMediaKind("image/jpeg")).toBe("image");
  });

  it("maps uppercase image MIME to image", () => {
    expect(detectLineMediaKind("IMAGE/JPEG")).toBe("image");
  });

  it("maps video MIME to video", () => {
    expect(detectLineMediaKind("video/mp4")).toBe("video");
  });

  it("maps audio MIME to audio", () => {
    expect(detectLineMediaKind("audio/mpeg")).toBe("audio");
  });

  it("falls back unknown MIME to image", () => {
    expect(detectLineMediaKind("application/octet-stream")).toBe("image");
  });
});

describe("resolveLineOutboundMedia", () => {
  beforeEach(() => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
  });

  it("respects explicit media kind without remote MIME probing", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", { mediaKind: "video" }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
    });
  });

  it("preserves explicit video kind when a preview URL is provided", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=123", {
        mediaKind: "video",
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=123",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("infers audio kind from explicit duration metadata when mediaKind is omitted", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio", {
        durationMs: 60000,
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "audio",
      durationMs: 60000,
    });
  });

  it("does not infer video from previewImageUrl alone", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/image.jpg", {
        previewImageUrl: "https://example.com/preview.jpg",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/image.jpg",
      mediaKind: "image",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("infers media kinds from known HTTPS file extensions", async () => {
    await expect(resolveLineOutboundMedia("https://example.com/audio.mp3")).resolves.toEqual({
      mediaUrl: "https://example.com/audio.mp3",
      mediaKind: "audio",
    });
    await expect(resolveLineOutboundMedia("https://example.com/video.mp4")).resolves.toEqual({
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
    });
    await expect(resolveLineOutboundMedia("https://example.com/image.jpg")).resolves.toEqual({
      mediaUrl: "https://example.com/image.jpg",
      mediaKind: "image",
    });
  });

  it("validates previewImageUrl when provided", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/video.mp4", {
        mediaKind: "video",
        previewImageUrl: "http://example.com/preview.jpg",
      }),
    ).rejects.toThrow(/must use HTTPS/i);
  });

  it("falls back to image when no explicit LINE media options or known extension are present", async () => {
    await expect(
      resolveLineOutboundMedia("https://example.com/download?id=audio"),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/download?id=audio",
      mediaKind: "image",
    });
  });

  it("rejects local paths because LINE outbound media requires public HTTPS URLs", async () => {
    await expect(resolveLineOutboundMedia("./assets/image.jpg")).rejects.toThrow(
      /requires a public https url/i,
    );
  });

  it("rejects non-HTTPS URL explicitly", async () => {
    await expect(resolveLineOutboundMedia("http://example.com/image.jpg")).rejects.toThrow(
      /must use HTTPS/i,
    );
  });
});
