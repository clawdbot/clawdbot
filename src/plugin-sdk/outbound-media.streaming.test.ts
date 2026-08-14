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

function createStoreFixture(
  namespace: string,
  options: { createId?: () => string; maxEntries?: number } = {},
) {
  const maxEntries = options.maxEntries ?? 10;
  const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
    "fixture-plugin",
    { namespace, maxEntries },
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
      createId: options.createId ?? (() => MEDIA_ID),
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries,
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

  it("revokes new access while an admitted chunk reader finishes", async () => {
    const { chunkStore, metadataStore, store } = createStoreFixture("active-reader-media");
    await prepareFixture(store);
    const stream = await store.readChunks(MEDIA_ID);

    await store.delete(MEDIA_ID);
    await expect(store.readMetadata(MEDIA_ID)).resolves.toBeNull();
    await expect(store.readChunks(MEDIA_ID)).resolves.toBeNull();
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

  it("does not return metadata when deletion starts during its lookup", async () => {
    const { metadataStore, store } = createStoreFixture("pending-metadata-media");
    await prepareFixture(store);
    const stream = await store.readChunks(MEDIA_ID);
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    let markLookupStarted: (() => void) | undefined;
    let releaseLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      const result = await originalLookup(key);
      markLookupStarted?.();
      await lookupReleased;
      return result;
    });

    const pendingMetadata = store.readMetadata(MEDIA_ID);
    await lookupStarted;
    await store.delete(MEDIA_ID);
    releaseLookup?.();

    await expect(pendingMetadata).resolves.toBeNull();
    await stream?.close();
  });

  it("preserves an active capability when capacity cannot evict it", async () => {
    const ids = [MEDIA_ID, "def456def456def456def456"];
    let idIndex = 0;
    const { metadataStore, store } = createStoreFixture("active-capacity-media", {
      createId: () => ids[idIndex++] ?? "ffffffffffffffffffffffff",
      maxEntries: 1,
    });
    await prepareFixture(store);
    const stream = await store.readChunks(ids[0] ?? "");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValueOnce({
      buffer: Buffer.from("replacement"),
      kind: "image",
      contentType: "image/png",
    });

    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/replacement.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("capacity is full while active readers retain entries");
    await expect(store.readMetadata(ids[0] ?? "")).resolves.not.toBeNull();

    const chunks: Buffer[] = [];
    for await (const chunk of stream?.chunks ?? []) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("image-bytes");
    await expect(store.readMetadata(ids[0] ?? "")).resolves.not.toBeNull();
    expect(await metadataStore.entries()).toHaveLength(1);
  });

  it("acquires the reader lease atomically with metadata lookup", async () => {
    const { chunkStore, metadataStore, store } = createStoreFixture("atomic-reader-media");
    await prepareFixture(store);
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    let markLookupStarted: (() => void) | undefined;
    let releaseLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      const result = await originalLookup(key);
      markLookupStarted?.();
      await lookupReleased;
      return result;
    });

    const pendingStream = store.readChunks(MEDIA_ID);
    await lookupStarted;
    const deletion = store.delete(MEDIA_ID);
    releaseLookup?.();
    const stream = await pendingStream;
    await deletion;

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
