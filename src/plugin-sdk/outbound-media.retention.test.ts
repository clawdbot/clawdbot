import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostedOutboundMediaChunkRecord,
  HostedOutboundMediaMetaRecord,
} from "./outbound-media.js";
import { createHostedOutboundMediaStore } from "./outbound-media.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "./plugin-state-test-runtime.js";
import * as webMedia from "./web-media.js";

const MEDIA_ID = "abc123abc123abc123abc123";

function prepare(store: ReturnType<typeof createHostedOutboundMediaStore>) {
  return store.prepareUrl({
    mediaUrl: "https://example.com/photo.png",
    routePath: "/hook/media/",
    publicBaseUrl: "https://gateway.example.com",
    maxBytes: 1024,
  });
}

describe("hosted outbound media post-expiry retention", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies new reads at logical expiry and deletes rows after serving grace", async () => {
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      { namespace: "retained-ttl-media", maxEntries: 10 },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      { namespace: "retained-ttl-media-chunks", maxEntries: 100 },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 100,
      postExpiryRetentionMs: 100,
      resolveExpiresAtMs: (ttlMs) => Date.now() + ttlMs,
      createId: () => MEDIA_ID,
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 10,
      maxChunkRows: 100,
    });

    await prepare(store);
    vi.setSystemTime(1_101);
    await expect(store.readMetadata(MEDIA_ID)).resolves.toBeNull();
    await store.cleanupExpired();
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(3);

    vi.setSystemTime(1_201);
    await store.cleanupExpired();
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("counts retained rows under reject-new capacity", async () => {
    const ids = [
      "111111111111111111111111",
      "222222222222222222222222",
      "333333333333333333333333",
    ];
    let idIndex = 0;
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "grace-capacity-media",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "grace-capacity-media-chunks",
        maxEntries: 10,
        overflowPolicy: "reject-new",
      }),
      ttlMs: 100,
      postExpiryRetentionMs: 100,
      resolveExpiresAtMs: (ttlMs) => Date.now() + ttlMs,
      createId: () => ids[idIndex++] ?? "444444444444444444444444",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 1,
      maxChunkRows: 10,
      overflowPolicy: "reject-new",
    });

    await expect(prepare(store)).resolves.toContain(ids[0]);
    vi.setSystemTime(1_101);
    await expect(prepare(store)).rejects.toThrow("capacity is full");

    vi.setSystemTime(1_201);
    await expect(prepare(store)).resolves.toContain(ids[2]);
  });
});

describe("hosted outbound media aggregate byte capacity", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a new entry without evicting a live capability", async () => {
    let id = 0;
    const ids = ["111111111111111111111111", "222222222222222222222222"];
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "aggregate-byte-media",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "aggregate-byte-media-chunks",
        maxEntries: 4,
        overflowPolicy: "reject-new",
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[id++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 4,
      maxTotalBytes: 5,
      overflowPolicy: "reject-new",
    });
    vi.mocked(webMedia.loadWebMedia).mockResolvedValue({
      buffer: Buffer.from("abc"),
      kind: "image",
      contentType: "image/png",
    });

    await store.prepareUrl({
      mediaUrl: "https://example.com/first.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 10,
    });
    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/second.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 10,
      }),
    ).rejects.toThrow("hosted outbound media capacity is full");
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).toBeNull();
  });

  it("rejects an individually oversized entry before evicting live capabilities", async () => {
    let id = 0;
    const ids = ["333333333333333333333333", "444444444444444444444444"];
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "evicting-byte-media",
        maxEntries: 2,
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "evicting-byte-media-chunks",
        maxEntries: 4,
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[id++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 4,
      maxTotalBytes: 5,
      overflowPolicy: "evict-oldest",
    });
    vi.mocked(webMedia.loadWebMedia)
      .mockResolvedValueOnce({
        buffer: Buffer.from("abc"),
        kind: "image",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("abcdef"),
        kind: "image",
        contentType: "image/png",
      });

    await store.prepareUrl({
      mediaUrl: "https://example.com/first.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 10,
    });
    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/oversized.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 10,
      }),
    ).rejects.toThrow("payload exceeds aggregate byte capacity");
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).toBeNull();
  });
});
