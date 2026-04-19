import * as ssrf from "openclaw/plugin-sdk/infra-runtime";
import * as mediaFetch from "openclaw/plugin-sdk/media-runtime";
import type { SavedMedia } from "openclaw/plugin-sdk/media-runtime";
import * as mediaStore from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { type FetchMock, withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinnedHostnameResolution } from "../../../../src/test-helpers/ssrf.js";
import {
  fetchWithSlackAuth,
  resolveSlackAttachmentContent,
  resolveSlackMedia,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
  resetSlackThreadStarterCacheForTest,
} from "./media.js";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
  danger: (message: string) => message,
  shouldLogVerbose: () => false,
}));

// Store original fetch
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn<FetchMock>>;
const createSavedMedia = (filePath: string, contentType: string): SavedMedia => ({
  id: "saved-media-id",
  path: filePath,
  size: 128,
  contentType,
});

function getRequestHeader(callIndex: number, headerName: string): string | null {
  const init = mockFetch.mock.calls[callIndex]?.[1];
  return new Headers(init?.headers).get(headerName);
}

async function expectPrivateDownloadRedirect(params: {
  location: string;
  redirectedUrl: string;
  secondAuthorization: string | null;
}) {
  vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
    createSavedMedia("/tmp/test.jpg", "image/jpeg"),
  );

  mockFetch
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: params.location },
      }),
    )
    .mockResolvedValueOnce(
      new Response(Buffer.from("image data"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );

  const result = await resolveSlackMedia({
    files: [{ url_private_download: "https://files.slack.com/download.jpg", name: "test.jpg" }],
    token: "xoxb-test-token",
    maxBytes: 1024 * 1024,
  });

  expect(result).not.toBeNull();
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0]?.[0]).toBe("https://files.slack.com/download.jpg");
  expect(mockFetch.mock.calls[1]?.[0]).toBe(params.redirectedUrl);
  expect(getRequestHeader(0, "Authorization")).toBe("Bearer xoxb-test-token");
  expect(getRequestHeader(1, "Authorization")).toBe(params.secondAuthorization);
}

describe("fetchWithSlackAuth", () => {
  beforeEach(() => {
    // Create a new mock for each test
    mockFetch = vi.fn<FetchMock>(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(),
    );
    globalThis.fetch = withFetchPreconnect(mockFetch);
  });

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  it("sends Authorization header on initial request with manual redirect", async () => {
    // Simulate direct 200 response (no redirect)
    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(mockResponse);

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/test.jpg", {
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });
  });

  it("rejects non-Slack hosts to avoid leaking tokens", async () => {
    await expect(
      fetchWithSlackAuth("https://example.com/test.jpg", "xoxb-test-token"),
    ).rejects.toThrow(/non-Slack host|non-Slack/i);

    // Should fail fast without attempting a fetch.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("strips Authorization header on cross-origin redirects", async () => {
    // First call: redirect response from Slack
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "https://cdn.slack-edge.com/presigned-url?sig=abc123" },
    });

    // Second call: actual file content from CDN
    const fileResponse = new Response(Buffer.from("actual image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(fileResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call should have Authorization header and manual redirect
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://files.slack.com/test.jpg", {
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });

    // Second call should follow the redirect without Authorization
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://cdn.slack-edge.com/presigned-url?sig=abc123",
      { redirect: "follow" },
    );
  });

  it("preserves Authorization header on same-origin redirects", async () => {
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: "/files/redirect-target" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/original.jpg", "xoxb-test-token");

    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://files.slack.com/files/redirect-target", {
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "follow",
    });
  });

  it("returns redirect response when no location header is provided", async () => {
    // Redirect without location header
    const redirectResponse = new Response(null, {
      status: 302,
      // No location header
    });

    mockFetch.mockResolvedValueOnce(redirectResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    // Should return the redirect response directly
    expect(result).toBe(redirectResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 4xx/5xx responses directly without following", async () => {
    const errorResponse = new Response("Not Found", {
      status: 404,
    });

    mockFetch.mockResolvedValueOnce(errorResponse);

    const result = await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(result).toBe(errorResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 301 permanent redirects", async () => {
    const redirectResponse = new Response(null, {
      status: 301,
      headers: { location: "https://cdn.slack.com/new-url" },
    });

    const fileResponse = new Response(Buffer.from("image data"), {
      status: 200,
    });

    mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fileResponse);

    await fetchWithSlackAuth("https://files.slack.com/test.jpg", "xoxb-test-token");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://cdn.slack.com/new-url", {
      redirect: "follow",
    });
  });
});

describe("resolveSlackMedia", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockPinnedHostnameResolution();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prefers url_private_download over url_private", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );

    const mockResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/private.jpg",
          url_private_download: "https://files.slack.com/download.jpg",
          name: "test.jpg",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://files.slack.com/download.jpg",
      expect.anything(),
    );
  });

  it("preserves Authorization on same-origin redirects for private downloads", async () => {
    await expectPrivateDownloadRedirect({
      location: "/files/redirect-target",
      redirectedUrl: "https://files.slack.com/files/redirect-target",
      secondAuthorization: "Bearer xoxb-test-token",
    });
  });

  it("strips Authorization on cross-origin redirects for private downloads", async () => {
    await expectPrivateDownloadRedirect({
      location: "https://downloads.slack-edge.com/presigned-url?sig=abc123",
      redirectedUrl: "https://downloads.slack-edge.com/presigned-url?sig=abc123",
      secondAuthorization: null,
    });
  });

  it("returns null when download fails", async () => {
    // Simulate a network error
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("returns null when no files are provided", async () => {
    const result = await resolveSlackMedia({
      files: [],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
  });

  it("skips files without url_private", async () => {
    const result = await resolveSlackMedia({
      files: [{ name: "test.jpg" }], // No url_private
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects HTML auth pages for non-HTML files", async () => {
    const saveMediaBufferMock = vi.spyOn(mediaStore, "saveMediaBuffer");
    mockFetch.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><body>login</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("allows expected HTML uploads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/page.html", "text/html"),
    );
    mockFetch.mockResolvedValueOnce(
      new Response("<!doctype html><html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/page.html",
          name: "page.html",
          mimetype: "text/html",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result?.[0]?.path).toBe("/tmp/page.html");
  });

  it("overrides video/* MIME to audio/* for slack_audio voice messages", async () => {
    // saveMediaBuffer re-detects MIME from buffer bytes, so it may return
    // video/mp4 for MP4 containers.  Verify resolveSlackMedia preserves
    // the overridden audio/* type in its return value despite this.
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/voice.mp4", "video/mp4"));

    const mockResponse = new Response(Buffer.from("audio data"), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/voice.mp4",
          name: "audio_message.mp4",
          mimetype: "video/mp4",
          subtype: "slack_audio",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 16 * 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    // saveMediaBuffer should receive the overridden audio/mp4
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      "audio/mp4",
      "inbound",
      16 * 1024 * 1024,
    );
    // Returned contentType must be the overridden value, not the
    // re-detected video/mp4 from saveMediaBuffer
    expect(result![0]?.contentType).toBe("audio/mp4");
  });

  it("preserves original MIME for non-voice Slack files", async () => {
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/video.mp4", "video/mp4"));

    const mockResponse = new Response(Buffer.from("video data"), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const result = await resolveSlackMedia({
      files: [
        {
          url_private: "https://files.slack.com/clip.mp4",
          name: "recording.mp4",
          mimetype: "video/mp4",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 16 * 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(saveMediaBufferMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      16 * 1024 * 1024,
    );
    expect(result![0]?.contentType).toBe("video/mp4");
  });

  it("falls through to next file when first file returns error", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );

    // First file: 404
    const errorResponse = new Response("Not Found", { status: 404 });
    // Second file: success
    const successResponse = new Response(Buffer.from("image data"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

    mockFetch.mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(successResponse);

    const result = await resolveSlackMedia({
      files: [
        { url_private: "https://files.slack.com/first.jpg", name: "first.jpg" },
        { url_private: "https://files.slack.com/second.jpg", name: "second.jpg" },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns all successfully downloaded files as an array", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (buffer, _contentType) => {
      const text = Buffer.from(buffer).toString("utf8");
      if (text.includes("image a")) {
        return createSavedMedia("/tmp/a.jpg", "image/jpeg");
      }
      if (text.includes("image b")) {
        return createSavedMedia("/tmp/b.png", "image/png");
      }
      return createSavedMedia("/tmp/unknown", "application/octet-stream");
    });

    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/a.jpg")) {
        return new Response(Buffer.from("image a"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.includes("/b.png")) {
        return new Response(Buffer.from("image b"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await resolveSlackMedia({
      files: [
        { url_private: "https://files.slack.com/a.jpg", name: "a.jpg" },
        { url_private: "https://files.slack.com/b.png", name: "b.png" },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toHaveLength(2);
    expect(result![0].path).toBe("/tmp/a.jpg");
    expect(result![0].placeholder).toBe("[Slack file: a.jpg]");
    expect(result![1].path).toBe("/tmp/b.png");
    expect(result![1].placeholder).toBe("[Slack file: b.png]");
  });

  it("caps downloads to 8 files for large multi-attachment messages", async () => {
    const saveMediaBufferMock = vi
      .spyOn(mediaStore, "saveMediaBuffer")
      .mockResolvedValue(createSavedMedia("/tmp/x.jpg", "image/jpeg"));

    mockFetch.mockImplementation(async () => {
      return new Response(Buffer.from("image data"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });

    const files = Array.from({ length: 9 }, (_, idx) => ({
      url_private: `https://files.slack.com/file-${idx}.jpg`,
      name: `file-${idx}.jpg`,
      mimetype: "image/jpeg",
    }));

    const result = await resolveSlackMedia({
      files,
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(8);
    expect(saveMediaBufferMock).toHaveBeenCalledTimes(8);
    expect(mockFetch).toHaveBeenCalledTimes(8);
  });

  it("routes dispatcher-backed Slack media requests through runtime fetch", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );
    globalThis.fetch = (async () => {
      throw new Error("global fetch should not receive dispatcher-backed Slack media requests");
    }) as typeof fetch;
    const runtimeFetchSpy = vi
      .spyOn(ssrf, "fetchWithRuntimeDispatcher")
      .mockImplementation(async () => {
        return new Response(Buffer.from("image data"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      });

    const result = await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).not.toBeNull();
    expect(runtimeFetchSpy).toHaveBeenCalled();
    expect(runtimeFetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(
      runtimeFetchSpy.mock.calls[0]?.[1] && "dispatcher" in runtimeFetchSpy.mock.calls[0][1],
    ).toBe(true);
    expect(new Headers(runtimeFetchSpy.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer xoxb-test-token",
    );
  });
});

describe("Slack media SSRF policy", () => {
  const originalFetchLocal = globalThis.fetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = withFetchPreconnect(mockFetch);
    mockPinnedHostnameResolution();
  });

  afterEach(() => {
    globalThis.fetch = originalFetchLocal;
    vi.restoreAllMocks();
  });

  it("passes ssrfPolicy with Slack CDN allowedHostnames and allowRfc2544BenchmarkRange to file downloads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/test.jpg", "image/jpeg"),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const spy = vi.spyOn(mediaFetch, "fetchRemoteMedia");

    await resolveSlackMedia({
      files: [{ url_private: "https://files.slack.com/test.jpg", name: "test.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
      }),
    );

    const policy = spy.mock.calls[0][0].ssrfPolicy;
    expect(policy?.allowedHostnames).toEqual(
      expect.arrayContaining(["*.slack.com", "*.slack-edge.com", "*.slack-files.com"]),
    );
  });

  it("passes ssrfPolicy to forwarded attachment image downloads", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/fwd.jpg", "image/jpeg"),
    );
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      return {
        hostname: normalized,
        addresses: ["93.184.216.34"],
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses: ["93.184.216.34"] }),
      };
    });
    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("fwd"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const spy = vi.spyOn(mediaFetch, "fetchRemoteMedia");

    await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
      }),
    );
  });
});

describe("resolveSlackAttachmentContent", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockPinnedHostnameResolution();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("ignores non-forwarded attachments", async () => {
    const result = await resolveSlackAttachmentContent({
      attachments: [
        {
          text: "unfurl text",
          is_msg_unfurl: true,
          image_url: "https://example.com/unfurl.jpg",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("extracts text from forwarded shared attachments", async () => {
    const result = await resolveSlackAttachmentContent({
      attachments: [
        {
          is_share: true,
          author_name: "Bob",
          text: "Please review this",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({
      text: "[Forwarded message from Bob]\nPlease review this",
      media: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips forwarded image URLs on non-Slack hosts", async () => {
    const saveMediaBufferMock = vi.spyOn(mediaStore, "saveMediaBuffer");

    const result = await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://example.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toBeNull();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("downloads Slack-hosted images from forwarded shared attachments", async () => {
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue(
      createSavedMedia("/tmp/forwarded.jpg", "image/jpeg"),
    );

    mockFetch.mockResolvedValueOnce(
      new Response(Buffer.from("forwarded image"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );

    const result = await resolveSlackAttachmentContent({
      attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.jpg" }],
      token: "xoxb-test-token",
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({
      text: "",
      media: [
        {
          path: "/tmp/forwarded.jpg",
          contentType: "image/jpeg",
          placeholder: "[Forwarded image: forwarded.jpg]",
        },
      ],
    });
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://files.slack.com/forwarded.jpg");
    const firstInit = firstCall?.[1];
    expect(firstInit?.redirect).toBe("manual");
    expect(new Headers(firstInit?.headers).get("Authorization")).toBe("Bearer xoxb-test-token");
  });
});

describe("resolveSlackThreadHistory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paginates and returns the latest N messages across pages", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 1}`,
          user: "U1",
          ts: `${i + 1}.000`,
        })),
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 60 }, (_, i) => ({
          text: `msg-${i + 201}`,
          user: "U1",
          ts: `${i + 201}.000`,
        })),
        response_metadata: { next_cursor: "" },
      });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      currentMessageTs: "260.000",
      limit: 5,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
      }),
    );
    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: true,
        cursor: "cursor-2",
      }),
    );
    expect(result.map((entry) => entry.ts)).toEqual([
      "255.000",
      "256.000",
      "257.000",
      "258.000",
      "259.000",
    ]);
  });

  it("includes file-only messages and drops empty-only entries", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        { text: "  ", ts: "1.000", files: [{ name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("[attached: screenshot.png]");
    expect(result[1]?.text).toBe("hello");
  });

  it("returns empty when limit is zero without calling Slack API", async () => {
    const replies = vi.fn();
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 0,
    });

    expect(result).toEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });

  it("returns empty and surfaces the error via logVerbose when Slack API throws", async () => {
    vi.mocked(logVerbose).mockClear();
    const replies = vi.fn().mockRejectedValueOnce(new Error("slack down"));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 20,
    });

    expect(result).toEqual([]);
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      expect.stringContaining("slack thread history fetch failed"),
    );
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("slack down"));
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("channel=C1"));
  });
});

describe("resolveSlackThreadStarter", () => {
  beforeEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.mocked(logVerbose).mockClear();
  });

  it("returns the starter message when the Slack API succeeds", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [{ text: "hello thread", user: "U1", ts: "1.000" }],
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toEqual({
      text: "hello thread",
      userId: "U1",
      botId: undefined,
      ts: "1.000",
      files: undefined,
    });
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns null when the starter message has no text or files", async () => {
    const replies = vi.fn().mockResolvedValueOnce({ messages: [{ text: "   ", user: "U1" }] });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toBeNull();
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns a placeholder starter when the root message only has files", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        {
          text: "   ",
          user: "U1",
          ts: "1.000",
          files: [{ name: "root.png", mimetype: "image/png" }],
        },
      ],
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toEqual({
      text: "[attached: root.png]",
      userId: "U1",
      botId: undefined,
      ts: "1.000",
      files: [{ name: "root.png", mimetype: "image/png" }],
    });
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns null and surfaces the error via logVerbose when Slack API throws", async () => {
    const replies = vi.fn().mockRejectedValueOnce(new Error("not_in_channel"));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C42",
      threadTs: "9.999",
      client,
    });

    expect(result).toBeNull();
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(
      expect.stringContaining("slack thread starter fetch failed"),
    );
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("not_in_channel"));
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("channel=C42"));
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("ts=9.999"));
  });

  it("surfaces non-Error thrown values via logVerbose", async () => {
    const replies = vi.fn().mockRejectedValueOnce("rate_limited");
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toBeNull();
    expect(vi.mocked(logVerbose)).toHaveBeenCalledWith(expect.stringContaining("rate_limited"));
  });
});
