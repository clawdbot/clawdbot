import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

type OutboundMediaModule = typeof import("./outbound-media.js");

let loadOutboundMediaFromUrl: OutboundMediaModule["loadOutboundMediaFromUrl"];

describe("loadOutboundMediaFromUrl", () => {
  beforeAll(async () => {
    const webMedia = await import("./web-media.js");
    vi.spyOn(webMedia, "loadWebMedia").mockImplementation(loadWebMediaMock);
    ({ loadOutboundMediaFromUrl } = await import("./outbound-media.js"));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    loadWebMediaMock.mockReset();
  });

  it("forwards maxBytes and mediaLocalRoots to loadWebMedia", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("file:///tmp/image.png", {
      maxBytes: 1024,
      mediaLocalRoots: ["/tmp/workspace-agent"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/image.png", {
      maxBytes: 1024,
      localRoots: ["/tmp/workspace-agent"],
    });
  });

  it("keeps options optional", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("https://example.com/image.png");

    expect(loadWebMediaMock).toHaveBeenCalledWith("https://example.com/image.png", {});
  });

  it("keeps local roots when host read capability is provided", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("x"));
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("/Users/peter/Pictures/image.png", {
      maxBytes: 2048,
      mediaLocalRoots: ["/tmp/workspace-agent"],
      mediaReadFile,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/Users/peter/Pictures/image.png", {
      maxBytes: 2048,
      localRoots: ["/tmp/workspace-agent"],
      readFile: mediaReadFile,
      hostReadCapability: true,
    });
  });

  it("rejects host read capability without explicit local roots", async () => {
    await expect(
      loadOutboundMediaFromUrl("/Users/peter/Pictures/image.png", {
        maxBytes: 2048,
        mediaReadFile: async () => Buffer.from("x"),
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");
  });

  it("allows explicit any opt-in for host read capability", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("x"));
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("/Users/peter/Pictures/image.png", {
      maxBytes: 2048,
      mediaLocalRoots: "any",
      mediaReadFile,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/Users/peter/Pictures/image.png", {
      maxBytes: 2048,
      localRoots: "any",
      readFile: mediaReadFile,
      hostReadCapability: true,
    });
  });
});
