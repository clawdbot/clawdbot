import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../../test/helpers/plugins/mock-http-response.js";
import { createDiffsHttpHandler } from "./http.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness } from "./test-helpers.js";

describe("DiffArtifactStore", () => {
  let rootDir: string;
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;

  beforeEach(async () => {
    ({
      rootDir,
      store,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-store-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupRootDir();
  });

  it("creates and retrieves an artifact", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
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

    const loaded = await store.getArtifact(artifact.id, artifact.token);
    expect(loaded?.id).toBe(artifact.id);
    expect(loaded?.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });
    expect(await store.readHtml(artifact.id)).toBe("<html>demo</html>");
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
    const loaded = await store.getArtifact(artifact.id, artifact.token);
    expect(loaded).toBeNull();
  });

  it("updates the stored file path", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const filePath = store.allocateFilePath(artifact.id);
    const updated = await store.updateFilePath(artifact.id, filePath);
    expect(updated.filePath).toBe(filePath);
    expect(updated.imagePath).toBe(filePath);
  });

  it("rejects file paths that escape the store root", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    await expect(store.updateFilePath(artifact.id, "../outside.png")).rejects.toThrow(
      "escapes store root",
    );
  });

  it("rejects tampered html metadata paths outside the store root", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });
    const metaPath = path.join(rootDir, artifact.id, "meta.json");
    const rawMeta = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(rawMeta) as { htmlPath: string };
    meta.htmlPath = "../outside.html";
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf8");

    await expect(store.readHtml(artifact.id)).rejects.toThrow("escapes store root");
  });

  it("creates standalone file artifacts with managed metadata", async () => {
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

    vi.setSystemTime(new Date(now.getTime() + 2_000));
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(standalone.filePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports image path aliases for backward compatibility", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const imagePath = store.allocateImagePath(artifact.id, "pdf");
    expect(imagePath).toMatch(/preview\.pdf$/);
    const standalone = await store.createStandaloneFileArtifact();
    expect(standalone.filePath).toMatch(/preview\.png$/);

    const updated = await store.updateImagePath(artifact.id, imagePath);
    expect(updated.filePath).toBe(imagePath);
    expect(updated.imagePath).toBe(imagePath);
  });

  it("allocates PDF file paths when format is pdf", async () => {
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const artifactPdf = store.allocateFilePath(artifact.id, "pdf");
    const standalonePdf = await store.createStandaloneFileArtifact({ format: "pdf" });
    expect(artifactPdf).toMatch(/preview\.pdf$/);
    expect(standalonePdf.filePath).toMatch(/preview\.pdf$/);
  });

  it("throttles cleanup sweeps across repeated artifact creation", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    store = new DiffArtifactStore({
      rootDir,
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
    expect(res.body).toBe("<html>viewer</html>");
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
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
        expect(res.body).toBe("<html>viewer</html>");
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
