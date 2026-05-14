import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
  };
});

function requireReadRemoteMediaBufferInput(): {
  url?: unknown;
  fetchImpl?: unknown;
  maxBytes?: unknown;
  ssrfPolicy?: unknown;
  retry?: unknown;
} {
  const [call] = readRemoteMediaBufferMock.mock.calls;
  if (!call) {
    throw new Error("expected readRemoteMediaBuffer call");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("expected readRemoteMediaBuffer input to be an object");
  }
  return input;
}

async function withBlockedLocalAttachmentFallback(
  prefix: string,
  run: (params: { cache: MediaAttachmentCache; fallbackUrl: string }) => Promise<void>,
) {
  await withTempDir({ prefix }, async (base) => {
    const attachmentRoot = path.join(base, "attachment");
    const allowedRoot = path.join(base, "allowed");
    const attachmentPath = path.join(attachmentRoot, "voice-note.m4a");
    const fallbackUrl = "https://example.com/fallback.jpg";
    await fs.mkdir(attachmentRoot, { recursive: true });
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.writeFile(attachmentPath, "ok");

    const cache = new MediaAttachmentCache(
      [{ index: 0, path: attachmentPath, url: fallbackUrl, mime: "image/jpeg" }],
      {
        localPathRoots: [allowedRoot],
      },
    );
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: Buffer.from("fallback-buffer"),
      contentType: "image/jpeg",
      fileName: "fallback.jpg",
    });

    await run({ cache, fallbackUrl });
  });
}

describe("media understanding attachment URL fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    readRemoteMediaBufferMock.mockReset();
  });

  it("getPath falls back to URL fetch when local path is blocked", async () => {
    await withBlockedLocalAttachmentFallback(
      "openclaw-media-cache-getpath-url-fallback-",
      async ({ cache, fallbackUrl }) => {
        const result = await cache.getPath({
          attachmentIndex: 0,
          maxBytes: 1024,
          timeoutMs: 1000,
        });
        // getPath should fall through to getBuffer URL fetch, write a temp file,
        // and return a path to that temp file instead of throwing.
        expect(path.dirname(result.path)).toBe(resolvePreferredOpenClawTmpDir());
        expect(path.basename(result.path).startsWith("openclaw-media-")).toBe(true);
        expect(path.extname(result.path)).toBe(".jpg");
        expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
        const fetchInput = requireReadRemoteMediaBufferInput();
        const fetchImpl = fetchInput.fetchImpl;
        expect(fetchInput).toStrictEqual({
          url: fallbackUrl,
          fetchImpl,
          maxBytes: 1024,
          ssrfPolicy: undefined,
          retry: expect.objectContaining({ attempts: 3 }),
        });
        expect(typeof fetchImpl).toBe("function");
        // Clean up the temp file
        if (result.cleanup) {
          await result.cleanup();
        }
      },
    );
  });

  it("falls back to URL fetch when local attachment canonicalization fails", async () => {
    await withBlockedLocalAttachmentFallback(
      "openclaw-media-cache-url-fallback-",
      async ({ cache, fallbackUrl }) => {
        const result = await cache.getBuffer({
          attachmentIndex: 0,
          maxBytes: 1024,
          timeoutMs: 1000,
        });
        expect(result.buffer.toString()).toBe("fallback-buffer");
        expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
        const fetchInput = requireReadRemoteMediaBufferInput();
        const fetchImpl = fetchInput.fetchImpl;
        expect(fetchInput).toStrictEqual({
          url: fallbackUrl,
          fetchImpl,
          maxBytes: 1024,
          ssrfPolicy: undefined,
          retry: expect.objectContaining({ attempts: 3 }),
        });
        expect(typeof fetchImpl).toBe("function");
      },
    );
  });
});
