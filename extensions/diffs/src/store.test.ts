// Diffs tests cover store plugin behavior.
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiffsHttpHandler } from "./http.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness, ensureCuratedViewerRuntimeForTests } from "./test-helpers.js";
import type { DiffArtifactBlobMetadata } from "./types.js";

beforeAll(async () => {
  await ensureCuratedViewerRuntimeForTests();
});

describe("DiffArtifactStore", () => {
  let rootDir: string;
  let store: DiffArtifactStore;
  let blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
  let reopenStore: Awaited<ReturnType<typeof createDiffStoreHarness>>["reopen"];
  let cleanupRootDir: () => Promise<void>;

  beforeEach(async () => {
    ({
      rootDir,
      store,
      blobStore,
      reopen: reopenStore,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-store-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupRootDir();
  });

  it("stores compressed viewer bytes and retrieves them with one authorized lookup", async () => {
    const lookup = vi.spyOn(blobStore, "lookup");
    const artifact = await store.createArtifact({
      html: "<html>demo é 🦀</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
      context: {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    });
    const stored = await blobStore.lookup(artifact.id);
    expect(stored?.metadata).toMatchObject({
      version: 1,
      kind: "viewer",
      encoding: "gzip",
      decodedBytes: Buffer.byteLength("<html>demo é 🦀</html>"),
    });
    expect(JSON.stringify(stored?.metadata)).not.toContain(artifact.token);
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });

    lookup.mockClear();
    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(loaded?.artifact.id).toBe(artifact.id);
    expect(loaded?.artifact.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>demo é 🦀</html>");
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(store.readAuthorizedViewer(artifact.id, "0".repeat(48))).resolves.toBeNull();
    await expect(store.readAuthorizedViewer(artifact.id, "short")).resolves.toBeNull();
  });

  it("caps artifact expiry instead of throwing near the Date boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000 - 1_000));

    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "patch",
      fileCount: 1,
      ttlMs: 60_000,
    });

    expect(artifact.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
  });

  it("serves viewer artifacts after reopening the shared SQLite store", async () => {
    const artifact = await store.createArtifact({
      html: "<html>persisted</html>",
      title: "Persisted",
      inputKind: "patch",
      fileCount: 1,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    ({ store, blobStore } = reopenStore());

    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>persisted</html>");
  });

  it("expires artifacts after the ttl", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);

    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "patch",
      fileCount: 2,
      ttlMs: 1_000,
    });

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(loaded).toBeNull();
    await expect(blobStore.deleteExpired()).resolves.toEqual([]);
  });

  it("creates standalone file artifacts with SQLite metadata and derived temp paths", async () => {
    const standalone = await store.createStandaloneFileArtifact({
      context: {
        agentId: "main",
        sessionId: "session-123",
      },
    });
    expect(standalone.filePath).toMatch(/preview\.png$/);
    expect(standalone.filePath).toContain(rootDir);
    expect(Date.parse(standalone.expiresAt)).toBeGreaterThan(Date.now());
    expect(standalone.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
    });
    await expect(blobStore.lookup(standalone.id)).resolves.toMatchObject({
      key: standalone.id,
      sizeBytes: 0,
      metadata: { version: 1, kind: "rendered_file", format: "png" },
    });
    await store.completeFileArtifact(standalone.id);
  });

  it("caps standalone file expiry instead of throwing near the Date boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000 - 1_000));

    const standalone = await store.createStandaloneFileArtifact({ ttlMs: 60_000 });

    expect(standalone.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
  });

  it("expires standalone file artifacts using ttl metadata", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);

    const standalone = await store.createStandaloneFileArtifact({
      format: "png",
      ttlMs: 1_000,
    });
    await fs.writeFile(standalone.filePath, Buffer.from("png"));
    await store.completeFileArtifact(standalone.id);

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    await store.cleanupExpired();

    const error = await fs.stat(path.dirname(standalone.filePath)).then(
      () => undefined,
      (statError: unknown) => statError,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("allocates PDF file paths when format is pdf", async () => {
    const standalonePdf = await store.createStandaloneFileArtifact({ format: "pdf" });
    expect(standalonePdf.filePath).toMatch(/preview\.pdf$/);
    await store.completeFileArtifact(standalonePdf.id);
  });

  it("drops an artifact row and temp directory after render failure", async () => {
    const standalone = await store.createStandaloneFileArtifact();
    await fs.writeFile(standalone.filePath, "partial");

    await store.deleteFileArtifact(standalone.id);

    await expect(blobStore.lookup(standalone.id)).resolves.toBeUndefined();
    await expect(fs.stat(path.dirname(standalone.filePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes only expired file rows and leaves live materializations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-27T16:00:00Z"));
    const expired = await store.createStandaloneFileArtifact({ ttlMs: 1_000 });
    const live = await store.createStandaloneFileArtifact({ ttlMs: 60_000 });
    await fs.writeFile(expired.filePath, "expired");
    await fs.writeFile(live.filePath, "live");
    await store.completeFileArtifact(expired.id);
    await store.completeFileArtifact(live.id);

    vi.setSystemTime(new Date("2026-02-27T16:00:02Z"));
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(expired.filePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(live.filePath)).resolves.toMatchObject({ size: 4 });
  });

  it("keeps expired file metadata claimable across later blob writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-27T16:00:00Z"));
    const expired = await store.createStandaloneFileArtifact({ ttlMs: 1_000 });
    await fs.writeFile(expired.filePath, "expired");
    await store.completeFileArtifact(expired.id);

    vi.setSystemTime(new Date("2026-02-27T16:00:02Z"));
    await blobStore.register(
      "later-write",
      new Uint8Array(),
      { version: 1, kind: "rendered_file", format: "png" },
      { ttlMs: 60_000 },
    );
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(expired.filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans expired rows and retries a quota-limited registration", async () => {
    const registerIfAbsent = blobStore.registerIfAbsent.bind(blobStore);
    const registerSpy = vi
      .spyOn(blobStore, "registerIfAbsent")
      .mockRejectedValueOnce(
        Object.assign(new Error("physical quota reached"), {
          code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
        }),
      )
      .mockImplementation(registerIfAbsent);
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await store.createArtifact({
      html: "<html>retry</html>",
      title: "Retry",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it("removes only old rowless temp directories without reading legacy metadata", async () => {
    const oldDir = path.join(rootDir, "a".repeat(20));
    const recentDir = path.join(rootDir, "b".repeat(20));
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(recentDir, { recursive: true });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(oldDir, oldTime, oldTime);

    await store.cleanupExpired();

    await expect(fs.stat(oldDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recentDir)).resolves.toMatchObject({});
  });

  it("throttles cleanup sweeps across repeated artifact creation", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    store = new DiffArtifactStore({
      rootDir,
      blobStore,
      cleanupIntervalMs: 60_000,
    });
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await store.createArtifact({
      html: "<html>one</html>",
      title: "One",
      inputKind: "before_after",
      fileCount: 1,
    });
    await store.createArtifact({
      html: "<html>two</html>",
      title: "Two",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 61_000));
    await store.createArtifact({
      html: "<html>three</html>",
      title: "Three",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});

describe("createDiffsHttpHandler", () => {
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;

  async function handleLocalGet(url: string) {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url,
      }),
      res,
    );
    return { handled, res };
  }

  beforeEach(async () => {
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness("openclaw-diffs-http-"));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("serves a stored diff document", async () => {
    const artifact = await createViewerArtifact(store);
    const { handled, res } = await handleLocalGet(artifact.viewerPath);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body as unknown as Uint8Array).toString("utf8")).toBe(
      "<html>viewer</html>",
    );
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects invalid tokens", async () => {
    const artifact = await createViewerArtifact(store);
    const { handled, res } = await handleLocalGet(
      artifact.viewerPath.replace(artifact.token, "bad-token"),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("rejects malformed artifact ids before reading from disk", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/view/not-a-real-id/not-a-real-token",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("serves the shared viewer asset", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/assets/viewer.js",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("./viewer-runtime.js?v=");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it("serves the shared viewer runtime asset", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/assets/viewer-runtime.js",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("openclawDiffsReady");
    expect(res.getHeader("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it.each([
    {
      name: "allows direct loopback viewer access by default",
      request: localReq,
      allowRemoteViewer: false,
      expectedStatusCode: 200,
    },
    {
      name: "allows ipv4-mapped ipv6 loopback viewer access by default",
      request: ipv4MappedLoopbackReq,
      allowRemoteViewer: false,
      expectedStatusCode: 200,
    },
    {
      name: "blocks non-loopback viewer access by default",
      request: remoteReq,
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks loopback requests that carry proxy forwarding headers by default",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks trusted-proxy loopback requests without client-origin headers by default",
      request: localReq,
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks proxied loopback requests when trusted proxies are configured",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "allows remote access when allowRemoteViewer is enabled",
      request: remoteReq,
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
    {
      name: "allows proxied loopback requests when allowRemoteViewer is enabled",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
  ])(
    "$name",
    async ({ request, headers, trustedProxies, allowRemoteViewer, expectedStatusCode }) => {
      const artifact = await createViewerArtifact(store);

      const handler = createDiffsHttpHandler({ store, allowRemoteViewer, trustedProxies });
      const res = createMockServerResponse();
      const handled = await handler(
        request({
          method: "GET",
          url: artifact.viewerPath,
          headers,
        }),
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(expectedStatusCode);
      if (expectedStatusCode === 200) {
        expect(Buffer.from(res.body as unknown as Uint8Array).toString("utf8")).toBe(
          "<html>viewer</html>",
        );
      }
    },
  );

  it("rate-limits repeated remote misses", async () => {
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });

    for (let i = 0; i < 40; i++) {
      const miss = createMockServerResponse();
      await handler(
        remoteReq({
          method: "GET",
          url: "/plugins/diffs/view/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
        miss,
      );
      expect(miss.statusCode).toBe(404);
    }

    const limited = createMockServerResponse();
    await handler(
      remoteReq({
        method: "GET",
        url: "/plugins/diffs/view/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      limited,
    );
    expect(limited.statusCode).toBe(429);
  });
});

async function createViewerArtifact(store: DiffArtifactStore) {
  return await store.createArtifact({
    html: "<html>viewer</html>",
    title: "Demo",
    inputKind: "before_after",
    fileCount: 1,
  });
}

function localReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function remoteReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as IncomingMessage;
}

function ipv4MappedLoopbackReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  } as unknown as IncomingMessage;
}
