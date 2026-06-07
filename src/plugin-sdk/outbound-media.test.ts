import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostedOutboundMediaChunkRecord,
  HostedOutboundMediaMetaRecord,
} from "./outbound-media.js";
// Outbound media tests cover plugin media attachment normalization and access policy.
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "./plugin-state-test-runtime.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

type OutboundMediaModule = typeof import("./outbound-media.js");

let createHostedOutboundMediaStore: OutboundMediaModule["createHostedOutboundMediaStore"];
let loadOutboundMediaFromUrl: OutboundMediaModule["loadOutboundMediaFromUrl"];

beforeAll(async () => {
  const webMedia = await import("./web-media.js");
  vi.spyOn(webMedia, "loadWebMedia").mockImplementation(loadWebMediaMock);
  ({ createHostedOutboundMediaStore, loadOutboundMediaFromUrl } =
    await import("./outbound-media.js"));
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetPluginStateStoreForTests();
  loadWebMediaMock.mockReset();
  vi.useRealTimers();
});

describe("loadOutboundMediaFromUrl", () => {
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

describe("createHostedOutboundMediaStore", () => {
  function createStore() {
    return createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "hosted-media",
        maxEntries: 10,
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "hosted-media-chunks",
        maxEntries: 100,
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => "abc123abc123abc123abc123",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 10,
      maxChunkRows: 100,
    });
  }

  it("stores hosted media chunks and reads them back", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const store = createStore();

    const url = await store.prepareUrl({
      mediaUrl: "https://example.com/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    const entry = await store.read("abc123abc123abc123abc123");

    expect(url).toBe(
      "https://gateway.example.com/hook/media/abc123abc123abc123abc123?token=token123",
    );
    expect(entry?.metadata).toMatchObject({
      routePath: "/hook/media/",
      token: "token123",
      contentType: "image/png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(entry?.buffer.toString("utf8")).toBe("image-bytes");
  });

  it("keeps metadata long enough to clean up expired chunk rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "ttl-media",
        maxEntries: 10,
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "ttl-media-chunks",
        maxEntries: 100,
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 100,
      resolveExpiresAtMs: (ttlMs) => Date.now() + ttlMs,
      createId: () => "abc123abc123abc123abc123",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 10,
      maxChunkRows: 100,
    });

    await store.prepareUrl({
      mediaUrl: "https://example.com/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(3);

    vi.setSystemTime(1101);
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toEqual([]);
    await store.cleanupExpired(1101);
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("deletes all chunks for one hosted entry", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const store = createStore();

    await store.prepareUrl({
      mediaUrl: "https://example.com/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    await store.delete("abc123abc123abc123abc123");

    expect(await store.read("abc123abc123abc123abc123")).toBeNull();
  });

  it("prunes oldest complete entries before chunk rows evict independently", async () => {
    let idCounter = 0;
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "capacity-media",
        maxEntries: 4,
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "capacity-media-chunks",
        maxEntries: 4,
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => {
        idCounter += 1;
        return idCounter === 1 ? "111111111111111111111111" : "222222222222222222222222";
      },
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 4,
    });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });

    await store.prepareUrl({
      mediaUrl: "https://example.com/first.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    await store.prepareUrl({
      mediaUrl: "https://example.com/second.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });

    expect(await store.read("111111111111111111111111")).toBeNull();
    expect(await store.read("222222222222222222222222")).not.toBeNull();
  });

  it("removes written chunks when metadata registration fails", async () => {
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "rollback-media",
        maxEntries: 10,
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "rollback-media-chunks",
        maxEntries: 100,
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore: {
        ...metadataStore,
        register: async () => {
          throw new Error("metadata write failed");
        },
      },
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => "333333333333333333333333",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 10,
      maxChunkRows: 100,
    });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });

    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/photo.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("metadata write failed");

    expect(await chunkStore.entries()).toHaveLength(0);
  });

  it("cleans chunks after helper-owned metadata expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
        "fixture-plugin",
        {
          namespace: "expiry-media-chunks",
          maxEntries: 100,
        },
      );
      const store = createHostedOutboundMediaStore({
        metadataStore: createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
          "fixture-plugin",
          {
            namespace: "expiry-media",
            maxEntries: 10,
          },
        ),
        chunkStore,
        ttlMs: 1_000,
        resolveExpiresAtMs: (ttlMs) => Date.now() + ttlMs,
        createId: () => "444444444444444444444444",
        createToken: () => "token123",
        rawChunkBytes: 4,
        maxEntries: 10,
        maxChunkRows: 100,
      });
      loadWebMediaMock.mockResolvedValue({
        buffer: Buffer.from("image-bytes"),
        kind: "image",
        contentType: "image/png",
      });

      await store.prepareUrl({
        mediaUrl: "https://example.com/photo.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      });
      expect(await chunkStore.entries()).toHaveLength(3);

      vi.setSystemTime(new Date(3_000));
      await store.cleanupExpired();

      expect(await chunkStore.entries()).toHaveLength(0);
      expect(await store.read("444444444444444444444444")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
