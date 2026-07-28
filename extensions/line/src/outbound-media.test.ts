// Line tests cover outbound media plugin behavior.
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
  buildLineMediaMessage,
  hasLineSpecificMediaOptions,
  resolveLineOutboundMedia,
  validateLineMediaUrl,
} from "./outbound-media.js";

const HTTPS_URL_ERROR = new Error("LINE outbound media URL must use HTTPS");

function createCredentialBearingHttpUrl(): string {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  url.hash = ["line", "fragment"].join("-");
  return url.href;
}

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

  it.each([
    {
      name: "malformed media URL",
      run: () => validateLineMediaUrl("not a url?query=fixture#fragment"),
      expected: new Error("LINE outbound media URL must be a valid URL"),
    },
    {
      name: "insecure media URL",
      run: () => validateLineMediaUrl(createCredentialBearingHttpUrl()),
      expected: HTTPS_URL_ERROR,
    },
    {
      name: "insecure preview URL",
      run: () =>
        resolveLineOutboundMedia("https://example.com/video.mp4", {
          mediaKind: "video",
          previewImageUrl: createCredentialBearingHttpUrl(),
        }),
      expected: HTTPS_URL_ERROR,
    },
    {
      name: "insecure resolved media URL",
      run: () => resolveLineOutboundMedia(createCredentialBearingHttpUrl()),
      expected: HTTPS_URL_ERROR,
    },
  ])("does not expose credentials from a $name", async ({ run, expected }) => {
    await expect(run()).rejects.toThrow(expected);
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
});

describe("hasLineSpecificMediaOptions", () => {
  it("is false for empty or text-only channel data", () => {
    expect(hasLineSpecificMediaOptions({})).toBe(false);
    expect(hasLineSpecificMediaOptions({ quickReplies: ["A"] })).toBe(false);
    expect(hasLineSpecificMediaOptions({ previewImageUrl: "  " })).toBe(false);
  });

  it("is true when any LINE media option is set", () => {
    expect(hasLineSpecificMediaOptions({ mediaKind: "video" })).toBe(true);
    expect(hasLineSpecificMediaOptions({ previewImageUrl: "https://x/p.jpg" })).toBe(true);
    expect(hasLineSpecificMediaOptions({ durationMs: 0 })).toBe(true);
    expect(hasLineSpecificMediaOptions({ durationMs: 1000 })).toBe(true);
    expect(hasLineSpecificMediaOptions({ trackingId: "t" })).toBe(true);
  });
});

describe("buildLineMediaMessage", () => {
  it("builds a video message and gates trackingId on user targets", async () => {
    const options = {
      mediaKind: "video" as const,
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-1",
    };
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", options, "line:user:Uabc"),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: "https://example.com/clip.mp4",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-1",
    });
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", options, "line:group:Cabc"),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: "https://example.com/clip.mp4",
      previewImageUrl: "https://example.com/preview.jpg",
    });
  });

  it("rejects a video missing its preview image", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/clip.mp4",
        { mediaKind: "video" },
        "line:user:Uabc",
      ),
    ).rejects.toThrow(/require previewImageUrl/i);
  });

  it("builds an audio message with a default duration", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/voice.m4a",
        { mediaKind: "audio" },
        "line:user:Uabc",
      ),
    ).resolves.toEqual({
      type: "audio",
      originalContentUrl: "https://example.com/voice.m4a",
      duration: 60000,
    });
  });

  it("defaults an image preview to the media URL", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/photo.png",
        { mediaKind: "image" },
        "line:user:Uabc",
      ),
    ).resolves.toEqual({
      type: "image",
      originalContentUrl: "https://example.com/photo.png",
      previewImageUrl: "https://example.com/photo.png",
    });
  });
});
