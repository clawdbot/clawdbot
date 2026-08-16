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
  it("forwards media limits, local roots, and image optimization to loadWebMedia", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
      fileName: "floor-plan.png",
    });

    await loadOutboundMediaFromUrl("file:///tmp/image.png", {
      maxBytes: 1024,
      mediaLocalRoots: ["/tmp/workspace-agent"],
      optimizeImages: false,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/image.png", {
      maxBytes: 1024,
      localRoots: ["/tmp/workspace-agent"],
      optimizeImages: false,
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
  function createStoreFixture(namespace = "hosted-media") {
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace,
        maxEntries: 10,
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: `${namespace}-chunks`,
        maxEntries: 100,
      },
    );
    return {
      metadataStore,
      chunkStore,
      store: createHostedOutboundMediaStore({
        metadataStore,
        chunkStore,
        ttlMs: 120_000,
        resolveExpiresAtMs: () => Date.now() + 120_000,
        createId: () => "abc123abc123abc123abc123",
        createToken: () => "token123",
        rawChunkBytes: 4,
        maxEntries: 10,
        maxChunkRows: 100,
      }),
    };
  }

  function createStore(namespace = "hosted-media") {
    return createStoreFixture(namespace).store;
  }

  it("stores hosted media chunks and reads them back", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "floor-plan.png",
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
      fileName: "floor-plan.png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(entry?.buffer.toString("utf8")).toBe("image-bytes");
  });

  it("validates the loaded bytes before persisting a capability", async () => {
    const media = {
      buffer: Buffer.from("active-bytes"),
      kind: undefined,
      contentType: "text/html",
      fileName: "active.html",
    };
    loadWebMediaMock.mockResolvedValueOnce(media);
    const store = createStore("hosted-media-validation");
    const validateBeforePersist = vi.fn(() => {
      throw new Error("active content rejected");
    });

    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/active.html",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
        validateBeforePersist,
      }),
    ).rejects.toThrow("active content rejected");

    expect(validateBeforePersist).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: media.buffer,
        contentType: "text/html",
        fileName: "active.html",
      }),
    );
    await expect(store.readMetadata("abc123abc123abc123abc123")).resolves.toBeNull();
  });

  it("does not return metadata when deletion starts during lookup", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const { metadataStore, store } = createStoreFixture("pending-metadata-media");
    await store.prepareUrl({
      mediaUrl: "https://example.com/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
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

    const pendingMetadata = store.readMetadata("abc123abc123abc123abc123");
    await lookupStarted;
    await store.delete("abc123abc123abc123abc123");
    releaseLookup?.();

    await expect(pendingMetadata).resolves.toBeNull();
  });

  it("lets an admitted complete read finish before deleting its chunks", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const { chunkStore, metadataStore, store } = createStoreFixture("atomic-reader-media");
    await store.prepareUrl({
      mediaUrl: "https://example.com/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
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

    const pendingRead = store.read("abc123abc123abc123abc123");
    await lookupStarted;
    await store.delete("abc123abc123abc123abc123");
    expect(await metadataStore.entries()).toHaveLength(1);
    expect(await chunkStore.entries()).toHaveLength(3);
    releaseLookup?.();

    await expect(pendingRead).resolves.toMatchObject({
      buffer: Buffer.from("image-bytes"),
    });
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("reads hosted metadata without hydrating chunk rows", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "metadata-only-media",
        maxEntries: 10,
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "metadata-only-media-chunks",
        maxEntries: 100,
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
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
    const chunkLookup = vi.spyOn(chunkStore, "lookup");

    await expect(store.readMetadata("abc123abc123abc123abc123")).resolves.toMatchObject({
      routePath: "/hook/media/",
      token: "token123",
      contentType: "image/png",
      byteLength: Buffer.byteLength("image-bytes"),
    });
    expect(chunkLookup).not.toHaveBeenCalled();
  });

  it("forwards local media access into hosted media preparation", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image-bytes"));
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const store = createStore();

    await store.prepareUrl({
      mediaUrl: "/workspace/photo.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
      mediaAccess: {
        localRoots: ["/workspace"],
        readFile: mediaReadFile,
        workspaceDir: "/workspace",
      },
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/workspace/photo.png", {
      maxBytes: 1024,
      localRoots: ["/workspace"],
      readFile: mediaReadFile,
      hostReadCapability: true,
      workspaceDir: "/workspace",
    });
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
      { namespace: "ttl-media", maxEntries: 10 },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      { namespace: "ttl-media-chunks", maxEntries: 100 },
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

  it("retains metadata until a failed chunk cleanup can be retried", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
    });
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "retry-delete-media",
        maxEntries: 10,
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "retry-delete-media-chunks",
        maxEntries: 100,
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
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
    const originalDelete = chunkStore.delete.bind(chunkStore);
    let deleteCalls = 0;
    vi.spyOn(chunkStore, "delete").mockImplementation(async (key) => {
      deleteCalls += 1;
      if (deleteCalls === 2) {
        throw new Error("chunk delete failed");
      }
      return await originalDelete(key);
    });

    await expect(store.delete("abc123abc123abc123abc123")).rejects.toThrow("chunk delete failed");
    expect(await metadataStore.entries()).toHaveLength(1);

    await expect(store.delete("abc123abc123abc123abc123")).resolves.toBeUndefined();
    expect(await metadataStore.entries()).toEqual([]);
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("serializes explicit deletion with reject-new capacity checks", async () => {
    let idCounter = 0;
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "serialized-delete-media",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "serialized-delete-media-chunks",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => {
        idCounter += 1;
        return idCounter === 1 ? "111111111111111111111111" : "222222222222222222222222";
      },
      createToken: () => "token123",
      rawChunkBytes: 64,
      maxEntries: 1,
      maxChunkRows: 1,
      overflowPolicy: "reject-new",
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
    let releaseDelete: (() => void) | undefined;
    let markDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const originalDelete = chunkStore.delete.bind(chunkStore);
    vi.spyOn(chunkStore, "delete").mockImplementationOnce(async (key) => {
      markDeleteStarted?.();
      await deleteReleased;
      return await originalDelete(key);
    });

    const deletion = store.delete("111111111111111111111111");
    await deleteStarted;
    const replacement = store.prepareUrl({
      mediaUrl: "https://example.com/second.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    let replacementSettled = false;
    void replacement.then(
      () => {
        replacementSettled = true;
      },
      () => {
        replacementSettled = true;
      },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(replacementSettled).toBe(false);
    releaseDelete?.();

    await expect(deletion).resolves.toBeUndefined();
    await expect(replacement).resolves.toContain("222222222222222222222222");
  });

  it("prunes oldest complete entries before chunk rows evict independently", async () => {
    let idCounter = 0;
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "capacity-media",
        maxEntries: 4,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "capacity-media-chunks",
        maxEntries: 4,
        overflowPolicy: "reject-new",
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

  it("deletes corrupt metadata by its stored key without revoking a live URL", async () => {
    const liveId = "111111111111111111111111";
    const corruptId = "222222222222222222222222";
    const metadataStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaMetaRecord>(
      "fixture-plugin",
      {
        namespace: "corrupt-capacity-media",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      },
    );
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "corrupt-capacity-media-chunks",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore,
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => liveId,
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 1,
      maxChunkRows: 1,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });
    await store.prepareUrl({
      mediaUrl: "https://example.com/live.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    await metadataStore.register(`media:${corruptId}:meta`, {
      id: liveId,
      routePath: "/hook/media/",
      token: "corrupt-token",
      contentType: "image/png",
      expiresAt: Date.now() + 120_000,
      chunkCount: 0,
      byteLength: 1,
    });

    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/rejected.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("hosted outbound media capacity is full");
    expect(await store.read(liveId)).not.toBeNull();
    expect(await metadataStore.lookup(`media:${corruptId}:meta`)).toBeUndefined();
  });

  it("rejects overflow without revoking existing live URLs", async () => {
    let idCounter = 0;
    const ids = [
      "111111111111111111111111",
      "222222222222222222222222",
      "333333333333333333333333",
    ];
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "reject-capacity-media",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "reject-capacity-media-chunks",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[idCounter++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 2,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("x"),
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

    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/third.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("hosted outbound media capacity is full");
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).not.toBeNull();
    expect(await store.read(ids[2] ?? "")).toBeNull();
  });

  it("serializes concurrent reject-new preparations without evicting live URLs", async () => {
    let idCounter = 0;
    const ids = [
      "111111111111111111111111",
      "222222222222222222222222",
      "333333333333333333333333",
    ];
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "concurrent-reject-capacity-media",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "concurrent-reject-capacity-media-chunks",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[idCounter++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 2,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await store.prepareUrl({
      mediaUrl: "https://example.com/existing.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    const results = await Promise.allSettled([
      store.prepareUrl({
        mediaUrl: "https://example.com/second.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
      store.prepareUrl({
        mediaUrl: "https://example.com/third.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    const liveNewEntries = await Promise.all(ids.slice(1).map(async (id) => await store.read(id)));
    expect(liveNewEntries.filter(Boolean)).toHaveLength(1);
  });

  it("rejects chunk-only overflow without revoking existing live URLs", async () => {
    let idCounter = 0;
    const ids = ["111111111111111111111111", "222222222222222222222222"];
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "reject-chunk-capacity-media",
        maxEntries: 3,
        overflowPolicy: "reject-new",
      }),
      chunkStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "reject-chunk-capacity-media-chunks",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[idCounter++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 3,
      maxChunkRows: 2,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock
      .mockResolvedValueOnce({
        buffer: Buffer.from("x"),
        kind: "image",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("12345"),
        kind: "image",
        contentType: "image/png",
      });

    await store.prepareUrl({
      mediaUrl: "https://example.com/existing.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/rejected.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("hosted outbound media capacity is full");

    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).toBeNull();
  });

  it("rolls back only new chunks when reject-new backing capacity races", async () => {
    let idCounter = 0;
    const ids = ["111111111111111111111111", "222222222222222222222222"];
    const chunkStore = createPluginStateKeyedStoreForTests<HostedOutboundMediaChunkRecord>(
      "fixture-plugin",
      {
        namespace: "backing-race-media-chunks",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      },
    );
    const store = createHostedOutboundMediaStore({
      metadataStore: createPluginStateKeyedStoreForTests("fixture-plugin", {
        namespace: "backing-race-media",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      }),
      chunkStore,
      ttlMs: 120_000,
      resolveExpiresAtMs: () => Date.now() + 120_000,
      createId: () => ids[idCounter++] ?? "ffffffffffffffffffffffff",
      createToken: () => "token123",
      rawChunkBytes: 4,
      maxEntries: 2,
      maxChunkRows: 3,
      overflowPolicy: "reject-new",
    });
    loadWebMediaMock
      .mockResolvedValueOnce({
        buffer: Buffer.from("x"),
        kind: "image",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("12345"),
        kind: "image",
        contentType: "image/png",
      });

    await store.prepareUrl({
      mediaUrl: "https://example.com/existing.png",
      routePath: "/hook/media/",
      publicBaseUrl: "https://gateway.example.com",
      maxBytes: 1024,
    });
    await expect(
      store.prepareUrl({
        mediaUrl: "https://example.com/racing.png",
        routePath: "/hook/media/",
        publicBaseUrl: "https://gateway.example.com",
        maxBytes: 1024,
      }),
    ).rejects.toThrow("reached its 2-row limit");

    expect(await store.read(ids[0] ?? "")).not.toBeNull();
    expect(await store.read(ids[1] ?? "")).toBeNull();
    expect(await chunkStore.entries()).toHaveLength(1);
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
