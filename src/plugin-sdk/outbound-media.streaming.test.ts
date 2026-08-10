import { beforeEach, describe, expect, it, vi } from "vitest";
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

function createStoreFixture(namespace: string) {
  const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
    "fixture-plugin",
    { namespace, maxEntries: 10 },
  );
  const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
    "fixture-plugin",
    { namespace: `${namespace}-chunks`, maxEntries: 100 },
  );
  return {
    chunkStore,
    metadataStore,
    store: createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => MEDIA_ID,
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 10,
      maxChunkRows: 100,
    }),
  };
}

async function prepareFixture(
  store: ReturnType<typeof createStoreFixture>["store"],
): Promise<void> {
  vi.spyOn(webMedia, "loadWebMedia").mockResolvedValueOnce({
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
}

describe("hosted outbound media chunk streaming", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("loads persisted chunks lazily in stored order", async () => {
    const { chunkStore, store } = createStoreFixture("streamed-media");
    await prepareFixture(store);
    const chunkLookup = vi.spyOn(chunkStore, "lookup");

    const stream = await store.readChunks(MEDIA_ID);
    expect(chunkLookup).not.toHaveBeenCalled();
    const chunks: Buffer[] = [];
    for await (const chunk of stream?.chunks ?? []) {
      chunks.push(chunk);
    }

    expect(chunkLookup).toHaveBeenCalledTimes(3);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("image-bytes");
  });

  it("defers deletion until an active chunk reader closes", async () => {
    const { chunkStore, metadataStore, store } = createStoreFixture("active-reader-media");
    await prepareFixture(store);
    const stream = await store.readChunks(MEDIA_ID);

    await store.delete(MEDIA_ID);
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(3);

    const chunks: Buffer[] = [];
    for await (const chunk of stream?.chunks ?? []) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("image-bytes");
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("deletes an entry whose persisted chunk size is corrupt", async () => {
    const { chunkStore, store } = createStoreFixture("corrupt-streamed-media");
    await prepareFixture(store);
    const originalLookup = chunkStore.lookup.bind(chunkStore);
    vi.spyOn(chunkStore, "lookup").mockImplementation(async (key) => {
      const chunk = await originalLookup(key);
      return chunk?.index === 1
        ? { ...chunk, dataBase64: Buffer.from("oversized").toString("base64") }
        : chunk;
    });
    const stream = await store.readChunks(MEDIA_ID);

    await expect(async () => {
      for await (const chunk of stream?.chunks ?? []) {
        void chunk;
      }
    }).rejects.toThrow("payload is incomplete");
    await expect(store.readMetadata(MEDIA_ID)).resolves.toBeNull();
  });
});
