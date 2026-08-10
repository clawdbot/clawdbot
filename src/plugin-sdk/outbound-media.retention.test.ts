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
