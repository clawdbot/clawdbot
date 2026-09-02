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

import { buildLineMediaMessage } from "./outbound-media.js";

const HTTPS_URL_ERROR = new Error("LINE outbound media URL must use HTTPS");
const USER_TARGET = "line:user:Uabc";
const PREVIEW_URL = "https://example.com/preview.jpg";

function createCredentialBearingHttpUrl(): string {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  url.hash = ["line", "fragment"].join("-");
  return url.href;
}

beforeEach(() => {
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
});

describe("buildLineMediaMessage URL boundary", () => {
  it("pins the hostname of an accepted HTTPS URL", async () => {
    await expect(
      buildLineMediaMessage("https://example.com/image.jpg", {}, USER_TARGET),
    ).resolves.toEqual({
      type: "image",
      originalContentUrl: "https://example.com/image.jpg",
      previewImageUrl: "https://example.com/image.jpg",
    });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("accepts an uppercase HTTPS scheme", async () => {
    await expect(
      buildLineMediaMessage("HTTPS://EXAMPLE.COM/img.jpg", {}, USER_TARGET),
    ).resolves.toMatchObject({ type: "image" });
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it.each([
    {
      name: "malformed media URL",
      run: () => buildLineMediaMessage("not a url?query=fixture#fragment", {}, USER_TARGET),
      expected: new Error("LINE outbound media currently requires a public HTTPS URL"),
    },
    {
      name: "insecure media URL",
      run: () => buildLineMediaMessage(createCredentialBearingHttpUrl(), {}, USER_TARGET),
      expected: HTTPS_URL_ERROR,
    },
    {
      name: "insecure preview URL",
      run: () =>
        buildLineMediaMessage(
          "https://example.com/video.mp4",
          { mediaKind: "video", previewImageUrl: createCredentialBearingHttpUrl() },
          USER_TARGET,
        ),
      expected: HTTPS_URL_ERROR,
    },
  ])("does not expose credentials from a $name", async ({ run, expected }) => {
    await expect(run()).rejects.toThrow(expected);
  });

  it("rejects a URL longer than 2000 chars before any hostname lookup", async () => {
    const longUrl = `https://example.com/${"a".repeat(1981)}`;
    expect(longUrl.length).toBeGreaterThan(2000);
    await expect(buildLineMediaMessage(longUrl, {}, USER_TARGET)).rejects.toThrow(
      /2000 chars or less/i,
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
  });

  it("rejects private-network targets through the shared SSRF policy", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("SSRF blocked private network target"),
    );

    await expect(
      buildLineMediaMessage("https://127.0.0.1/image.jpg", {}, USER_TARGET),
    ).rejects.toThrow(/private network/i);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("127.0.0.1", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("rejects a local path because LINE outbound media requires public HTTPS URLs", async () => {
    await expect(buildLineMediaMessage("./assets/image.jpg", {}, USER_TARGET)).rejects.toThrow(
      /requires a public https url/i,
    );
  });
});

describe("buildLineMediaMessage kind resolution", () => {
  it("respects an explicit media kind without remote MIME probing", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/download?id=123",
        { mediaKind: "video", previewImageUrl: PREVIEW_URL },
        USER_TARGET,
      ),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: "https://example.com/download?id=123",
      previewImageUrl: PREVIEW_URL,
    });
  });

  it("infers audio from explicit duration metadata when mediaKind is omitted", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/download?id=audio",
        { durationMs: 30000 },
        USER_TARGET,
      ),
    ).resolves.toEqual({
      type: "audio",
      originalContentUrl: "https://example.com/download?id=audio",
      duration: 30000,
    });
  });

  it("does not infer video from previewImageUrl alone", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/image.jpg",
        { previewImageUrl: PREVIEW_URL },
        USER_TARGET,
      ),
    ).resolves.toEqual({
      type: "image",
      originalContentUrl: "https://example.com/image.jpg",
      previewImageUrl: PREVIEW_URL,
    });
  });

  it.each([
    { url: "https://example.com/audio.mp3", expectedType: "audio" },
    { url: "https://example.com/voice.m4a", expectedType: "audio" },
    { url: "https://example.com/image.jpg", expectedType: "image" },
    { url: "https://example.com/image.png", expectedType: "image" },
    // An extensionless URL carries no evidence at all.
    { url: "https://example.com/download?id=audio", expectedType: "image" },
  ])("reads $url as a $expectedType message", async ({ url, expectedType }) => {
    await expect(buildLineMediaMessage(url, {}, USER_TARGET)).resolves.toMatchObject({
      type: expectedType,
      originalContentUrl: url,
    });
  });

  it.each([
    // These suffixes name formats LINE cannot carry in its native message types.
    "https://example.com/image.webp",
    "https://example.com/animation.gif",
    "https://example.com/clip.mov",
    "https://example.com/clip.webm",
    "https://example.com/audio.wav",
    "https://example.com/audio.ogg",
    "https://example.com/report.pdf",
    "https://example.com/archive.zip",
    "https://example.com/file.unknown",
  ])("delivers unsupported %s as its URL", async (url) => {
    await expect(buildLineMediaMessage(url, {}, USER_TARGET)).resolves.toEqual({
      type: "text",
      text: url,
    });
  });

  it("reads an MP4 URL as a video message once a preview image exists", async () => {
    const url = "https://example.com/video.mp4";
    await expect(
      buildLineMediaMessage(url, { previewImageUrl: PREVIEW_URL }, USER_TARGET),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: url,
      previewImageUrl: PREVIEW_URL,
    });
  });

  it("names the missing preview image when the caller asked for a video", async () => {
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", { mediaKind: "video" }, USER_TARGET),
    ).rejects.toThrow(/require previewImageUrl/i);
  });

  it("names the missing preview image when tracking metadata declares video intent", async () => {
    await expect(
      buildLineMediaMessage(
        "https://example.com/download?id=video",
        { trackingId: "track-1" },
        USER_TARGET,
      ),
    ).rejects.toThrow(/require previewImageUrl/i);
  });

  it("delivers an inferred video without a poster as its URL", async () => {
    // Nobody asked for a video here, so a hard failure would lose a send the
    // caller only described by its URL.
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", {}, USER_TARGET),
    ).resolves.toEqual({ type: "text", text: "https://example.com/clip.mp4" });
  });

  it("gates trackingId on user targets", async () => {
    const options = {
      mediaKind: "video" as const,
      previewImageUrl: PREVIEW_URL,
      trackingId: "track-1",
    };
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", options, USER_TARGET),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: "https://example.com/clip.mp4",
      previewImageUrl: PREVIEW_URL,
      trackingId: "track-1",
    });
    await expect(
      buildLineMediaMessage("https://example.com/clip.mp4", options, "line:group:Cabc"),
    ).resolves.toEqual({
      type: "video",
      originalContentUrl: "https://example.com/clip.mp4",
      previewImageUrl: PREVIEW_URL,
    });
  });

  it("builds an audio message with a default duration", async () => {
    await expect(
      buildLineMediaMessage("https://example.com/voice.m4a", { mediaKind: "audio" }, USER_TARGET),
    ).resolves.toEqual({
      type: "audio",
      originalContentUrl: "https://example.com/voice.m4a",
      duration: 60000,
    });
  });

  it("defaults an image preview to the media URL", async () => {
    await expect(
      buildLineMediaMessage("https://example.com/photo.png", { mediaKind: "image" }, USER_TARGET),
    ).resolves.toEqual({
      type: "image",
      originalContentUrl: "https://example.com/photo.png",
      previewImageUrl: "https://example.com/photo.png",
    });
  });
});
