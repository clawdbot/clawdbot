import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withFetchPreconnect(fetchSpy);

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads local attachments inside configured roots", async () => {
    await withLocalAttachmentCache("openclaw-media-cache-allowed-", async ({ cache }) => {
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
        const [openedPath, openedFlags] = openSpy.mock.calls[0] ?? [];
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
      const originalRealpath = fs.realpath.bind(fs);

      vi.spyOn(fs, "realpath").mockImplementation(async (candidatePath) => {
        if (String(candidatePath) === attachmentPath) {
          throw new Error("EACCES");
        }
        return await originalRealpath(candidatePath);
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/could not be canonicalized/i);
    });
  });
});
