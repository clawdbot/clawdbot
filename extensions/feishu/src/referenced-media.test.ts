import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const saveMessageResourceFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  saveMessageResourceFeishu: saveMessageResourceFeishuMock,
}));

let resolveFeishuReferencedMessageMedia: typeof import("./referenced-media.js").resolveFeishuReferencedMessageMedia;
let clearFeishuReferencedMediaCacheForTests: typeof import("./referenced-media.js").clearFeishuReferencedMediaCacheForTests;

// recallReferencedMedia verifies cached paths still exist on disk, so mocked
// save results must point at real files. macOS tmpdir is a symlink; realpath
// keeps assertions canonical.
let mediaDir: string;

function makeSavedFile(name: string, contents = "bytes"): string {
  const filePath = path.join(mediaDir, name);
  writeFileSync(filePath, contents);
  return filePath;
}

beforeEach(async () => {
  vi.clearAllMocks();
  ({ resolveFeishuReferencedMessageMedia, clearFeishuReferencedMediaCacheForTests } =
    await import("./referenced-media.js"));
  clearFeishuReferencedMediaCacheForTests();
  mediaDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "feishu-ref-media-")));
});

afterEach(() => {
  clearFeishuReferencedMediaCacheForTests();
  rmSync(mediaDir, { recursive: true, force: true });
});

describe("resolveFeishuReferencedMessageMedia", () => {
  it("downloads, saves, and reports byte count for a fresh image_key", async () => {
    const buf = Buffer.from("img-bytes");
    const savedPath = makeSavedFile("uuid-1.png");
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: {
        path: savedPath,
        contentType: "image/png",
        size: buf.byteLength,
      },
      contentType: "image/png",
    });

    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_quoted_1",
      messageType: "image",
      mediaKeys: { imageKey: "img_v2_abc" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(out.entries).toEqual([
      {
        media: { path: savedPath, contentType: "image/png", kind: "image" },
        size: buf.byteLength,
      },
    ]);
    expect(out.failedDownloads).toBe(0);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(1);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 1024 * 1024 }),
    );
  });

  it("downloads every embedded post image and media resource within the shared budget", async () => {
    const imageBuffer = Buffer.from("img");
    const videoBuffer = Buffer.from("vid");
    const imagePath = makeSavedFile("img.png");
    const clipPath = makeSavedFile("clip.mp4");
    saveMessageResourceFeishuMock
      .mockResolvedValueOnce({
        saved: {
          path: imagePath,
          contentType: "image/png",
          size: imageBuffer.byteLength,
        },
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        saved: {
          path: clipPath,
          contentType: "video/mp4",
          size: videoBuffer.byteLength,
        },
        contentType: "video/mp4",
      });

    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post_1",
      messageType: "post",
      mediaKeys: {
        imageKeys: ["img_post_1"],
        mediaKeys: [{ fileKey: "file_post_1", fileName: "clip.mp4" }],
      },
      maxBytes: 10,
      accountId: "acct_a",
    });

    expect(out.entries).toEqual([
      {
        media: { path: imagePath, contentType: "image/png", kind: "image" },
        size: imageBuffer.byteLength,
      },
      {
        media: { path: clipPath, contentType: "video/mp4", kind: "video" },
        size: videoBuffer.byteLength,
      },
    ]);
    expect(saveMessageResourceFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fileKey: "img_post_1",
        type: "image",
        maxBytes: 10,
      }),
    );
    expect(saveMessageResourceFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fileKey: "file_post_1",
        type: "file",
        maxBytes: 7,
        originalFilename: "clip.mp4",
      }),
    );
  });

  it("returns the cached media on a repeat call for the same image_key without re-downloading", async () => {
    const buf = Buffer.from("img-bytes");
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: {
        path: makeSavedFile("uuid-cached.png"),
        contentType: "image/png",
        size: buf.byteLength,
      },
    });

    const first = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_quoted_1",
      messageType: "image",
      mediaKeys: { imageKey: "img_shared" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    const second = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      // Same key referenced from a different message later in the topic.
      messageId: "om_history_2",
      messageType: "image",
      mediaKeys: { imageKey: "img_shared" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(first.entries).toEqual(second.entries);
    // Cache hits report their saved size too: the caller's budget bounds
    // delivered media per turn, not just wire downloads.
    expect(second.entries[0]?.size).toBe(buf.byteLength);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("scopes the cache by accountId so two accounts don't cross-pollute", async () => {
    saveMessageResourceFeishuMock
      .mockResolvedValueOnce({
        saved: { path: makeSavedFile("a.png"), contentType: "image/png", size: 1 },
      })
      .mockResolvedValueOnce({
        saved: { path: makeSavedFile("b.png"), contentType: "image/png", size: 1 },
      });

    await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "image",
      mediaKeys: { imageKey: "shared_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_2",
      messageType: "image",
      mediaKeys: { imageKey: "shared_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_b",
    });

    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures so transient API errors can be retried", async () => {
    saveMessageResourceFeishuMock
      .mockRejectedValueOnce(new Error("transient 503"))
      .mockResolvedValueOnce({
        saved: { path: makeSavedFile("retry.png"), contentType: "image/png", size: 1 },
      });

    const failed = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "image",
      mediaKeys: { imageKey: "k" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    const recovered = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "image",
      mediaKeys: { imageKey: "k" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(failed.entries).toEqual([]);
    expect(failed.failedDownloads).toBe(1);
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.failedDownloads).toBe(0);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("re-downloads when the cached file was pruned from disk", async () => {
    const prunedPath = makeSavedFile("pruned.png");
    const freshPath = makeSavedFile("fresh.png");
    saveMessageResourceFeishuMock
      .mockResolvedValueOnce({
        saved: { path: prunedPath, contentType: "image/png", size: 1 },
      })
      .mockResolvedValueOnce({
        saved: { path: freshPath, contentType: "image/png", size: 1 },
      });

    const first = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "image",
      mediaKeys: { imageKey: "pruned_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    // Simulate the media store TTL sweep removing the inbound file.
    unlinkSync(prunedPath);
    const second = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_2",
      messageType: "image",
      mediaKeys: { imageKey: "pruned_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(first.entries[0]?.media.path).toBe(prunedPath);
    expect(second.entries[0]?.media.path).toBe(freshPath);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("classifies a video poster image_key as an image, not a video", async () => {
    const posterPath = makeSavedFile("poster.png");
    const videoPath = makeSavedFile("clip.mp4");
    saveMessageResourceFeishuMock
      .mockResolvedValueOnce({
        saved: { path: posterPath, contentType: "image/png", size: 1 },
      })
      .mockResolvedValueOnce({
        saved: { path: videoPath, contentType: "video/mp4", size: 1 },
      });

    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_video",
      messageType: "media",
      mediaKeys: { imageKey: "poster_key", fileKey: "video_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(out.entries.map((entry) => entry.media)).toEqual([
      { path: posterPath, contentType: "image/png", kind: "image" },
      { path: videoPath, contentType: "video/mp4", kind: "video" },
    ]);
    expect(saveMessageResourceFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fileKey: "poster_key", type: "image" }),
    );
    expect(saveMessageResourceFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileKey: "video_key", type: "file" }),
    );
  });

  it("stops attempting resources once maxFailedDownloads is reached", async () => {
    saveMessageResourceFeishuMock.mockRejectedValue(new Error("expired key"));

    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post_bad",
      messageType: "post",
      mediaKeys: {
        imageKeys: ["bad_1", "bad_2", "bad_3", "bad_4", "bad_5"],
      },
      maxBytes: 1024 * 1024,
      maxFailedDownloads: 2,
      accountId: "acct_a",
    });

    expect(out.entries).toEqual([]);
    expect(out.failedDownloads).toBe(2);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the cached file's mtime on recall so the prune TTL restarts", async () => {
    const cachedPath = makeSavedFile("touched.png");
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: { path: cachedPath, contentType: "image/png", size: 1 },
    });
    await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "image",
      mediaKeys: { imageKey: "touch_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    // Age the file to the brink of the media-store prune TTL.
    const past = Date.now() - 10 * 60 * 1000;
    utimesSync(cachedPath, past / 1000, past / 1000);

    const recalled = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_2",
      messageType: "image",
      mediaKeys: { imageKey: "touch_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(recalled.entries[0]?.media.path).toBe(cachedPath);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(1);
    expect(statSync(cachedPath).mtimeMs).toBeGreaterThan(Date.now() - 60 * 1000);
  });

  it("re-applies the current message's kind when recalling a cached file key", async () => {
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: { path: makeSavedFile("shared.bin"), contentType: "video/mp4", size: 1 },
    });

    const asFile = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file_msg",
      messageType: "file",
      mediaKeys: { fileKey: "shared_file_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });
    const asVideo = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_video_msg",
      messageType: "media",
      mediaKeys: { fileKey: "shared_file_key" },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    expect(asFile.entries[0]?.media.kind).toBe("document");
    expect(asVideo.entries[0]?.media.kind).toBe("video");
    expect(asVideo.entries[0]?.media.path).toBe(asFile.entries[0]?.media.path);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("serves cache hits even after the failed-download quota is exhausted", async () => {
    const cachedPath = makeSavedFile("cached-after-failures.png");
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: { path: cachedPath, contentType: "image/png", size: 1 },
    });
    await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_warm",
      messageType: "post",
      mediaKeys: { imageKeys: ["good_key"] },
      maxBytes: 1024 * 1024,
      accountId: "acct_a",
    });

    saveMessageResourceFeishuMock.mockRejectedValue(new Error("expired key"));
    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_mixed",
      messageType: "post",
      mediaKeys: { imageKeys: ["bad_1", "bad_2", "good_key"] },
      maxBytes: 1024 * 1024,
      maxFailedDownloads: 2,
      accountId: "acct_a",
    });

    expect(out.failedDownloads).toBe(2);
    expect(out.entries).toEqual([
      expect.objectContaining({
        media: expect.objectContaining({ path: cachedPath, kind: "image" }),
      }),
    ]);
  });

  it("stops serving cached media once the delivered-bytes budget is spent", async () => {
    const bigPath = makeSavedFile("big.bin");
    saveMessageResourceFeishuMock.mockResolvedValueOnce({
      saved: { path: bigPath, contentType: "application/octet-stream", size: 10 },
    });
    await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_warm",
      messageType: "file",
      mediaKeys: { fileKey: "big_key" },
      maxBytes: 1024,
      accountId: "acct_a",
    });

    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_broke",
      messageType: "file",
      mediaKeys: { fileKey: "big_key" },
      maxBytes: 5,
      accountId: "acct_a",
    });

    expect(out.entries).toEqual([]);
    expect(saveMessageResourceFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty when neither image_key nor file_key is present", async () => {
    const out = await resolveFeishuReferencedMessageMedia({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
      messageType: "text",
      mediaKeys: {},
      maxBytes: 1024 * 1024,
    });

    expect(out.entries).toEqual([]);
    expect(out.failedDownloads).toBe(0);
    expect(saveMessageResourceFeishuMock).not.toHaveBeenCalled();
  });
});
