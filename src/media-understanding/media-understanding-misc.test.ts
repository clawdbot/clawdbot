import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes chatType", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("dm")).toBe("direct");
    expect(normalizeMediaUnderstandingChatType("room")).toBeUndefined();
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as Parameters<typeof resolveMediaUnderstandingScope>[0]["scope"];

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

const originalFetch = globalThis.fetch;

async function withLocalAttachmentCache(
  prefix: string,
  run: (params: {
    cache: MediaAttachmentCache;
    attachmentPath: string;
    canonicalAttachmentPath: string;
  }) => Promise<void>,
) {
  await withTempDir({ prefix }, async (base) => {
    const allowedRoot = path.join(base, "allowed");
    const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.writeFile(attachmentPath, "ok");
    const canonicalAttachmentPath = await fs.realpath(attachmentPath).catch(() => attachmentPath);

    const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
      localPathRoots: [allowedRoot],
    });

    await run({ cache, attachmentPath, canonicalAttachmentPath });
  });
}

describe("media understanding attachments SSRF", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function requireFirstOpenCall(openSpy: ReturnType<typeof vi.spyOn>): unknown[] {
    const [call] = openSpy.mock.calls;
    if (!call) {
      throw new Error("expected fs.open call");
    }
    return call;
  }

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withFetchPreconnect(fetchSpy);

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows RFC2544 benchmark-range URLs only when media fetch policy opts in", async () => {
    const url = "http://198.18.0.153/file.jpg";
    const deniedCache = new MediaAttachmentCache([{ index: 0, url }]);
    await expect(
      deniedCache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("image", {
        headers: { "content-type": "image/jpeg" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const allowedCache = new MediaAttachmentCache([{ index: 0, url }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await allowedCache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });
    expect(result).toStrictEqual({
      buffer: Buffer.from("image"),
      mime: "image/jpeg",
      fileName: "file.jpg",
      size: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses fetched content type instead of wildcard selection hints", async () => {
    const url = "http://198.18.0.153/image";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("image", {
        headers: { "content-type": "image/png" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "image/*" }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe("image/png");
    expect(result.fileName).toBe("image.png");
  });

  it("reads local attachments inside configured roots", async () => {
    await withLocalAttachmentCache("openclaw-media-cache-allowed-", async ({ cache }) => {
      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("ok");
    });
  });

  it("resolves relative attachment paths against the provided workspaceDir", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-workspace-" }, async (base) => {
      const workspaceDir = path.join(base, "workspace");
      const attachmentPath = path.join(workspaceDir, "media", "inbound", "report.pdf");
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache([{ index: 0, path: "media/inbound/report.pdf" }], {
        localPathRoots: [workspaceDir],
        workspaceDir,
      });

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("ok");
    });
  });

  it("blocks local attachments outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const cache = new MediaAttachmentCache([{ index: 0, path: "/etc/passwd" }], {
      localPathRoots: ["/Users/*/Library/Messages/Attachments"],
    });

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("blocks directory attachments even inside configured roots", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-dir-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "nested");
      await fs.mkdir(attachmentPath, { recursive: true });

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/not a regular file/i);
    });
  });

  it("blocks symlink escapes that resolve outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-media-cache-symlink-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const outsidePath = "/etc/passwd";
      const symlinkPath = path.join(allowedRoot, "note.txt");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.symlink(outsidePath, symlinkPath);

      const cache = new MediaAttachmentCache([{ index: 0, path: symlinkPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/outside allowed roots/i);
    });
  });

  it("enforces maxBytes after reading local attachments", async () => {
    await withLocalAttachmentCache(
      "openclaw-media-cache-max-bytes-",
      async ({ cache, canonicalAttachmentPath }) => {
        const originalOpen = fs.open.bind(fs);
        const openSpy = vi.spyOn(fs, "open");

        openSpy.mockImplementation(async (filePath, flags) => {
          const handle = await originalOpen(filePath, flags);
          const candidatePath = await fs.realpath(String(filePath)).catch(() => String(filePath));
          if (candidatePath !== canonicalAttachmentPath) {
            return handle;
          }
          const mockedHandle = handle as typeof handle & {
            readFile: typeof handle.readFile;
          };
          mockedHandle.readFile = (async () => Buffer.alloc(2048, 1)) as typeof handle.readFile;
          return mockedHandle;
        });

        await expect(
          cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
        ).rejects.toThrow(/exceeds maxBytes 1024/i);
      },
    );
  });

  it("opens local attachments with nofollow on posix", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withLocalAttachmentCache(
      "openclaw-media-cache-flags-",
      async ({ cache, canonicalAttachmentPath }) => {
        const openSpy = vi.spyOn(fs, "open");

        await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

        expect(openSpy).toHaveBeenCalled();
        const [openedPath, openedFlags] = requireFirstOpenCall(openSpy);
        expect(await fs.realpath(String(openedPath)).catch(() => String(openedPath))).toBe(
          canonicalAttachmentPath,
        );
        expect(openedFlags).toBe(fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      },
    );
  });

  it("rejects local attachments when canonicalization fails", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-realpath-failure-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });
      vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
        if (params.filePath === attachmentPath) {
          throw new Error("EACCES");
        }
        throw new Error(`Unexpected attachment path: ${params.filePath}`);
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/could not be canonicalized/i);
    });
  });
});
