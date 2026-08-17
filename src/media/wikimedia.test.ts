import { describe, expect, it, vi } from "vitest";
import { withWikimediaOriginalFallback } from "./wikimedia.js";

const THUMB =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/007_American_Pit_Bull_Terrier.jpg/800px-007_American_Pit_Bull_Terrier.jpg";
const ORIGINAL =
  "https://upload.wikimedia.org/wikipedia/commons/8/88/007_American_Pit_Bull_Terrier.jpg";

describe("withWikimediaOriginalFallback", () => {
  it("retries the ORIGINAL file (thumb -> original rewrite) when the first run fails", async () => {
    const run = vi.fn(async (url: string) => {
      if (url === THUMB) {
        throw new Error("400");
      }
      return url;
    });
    await expect(withWikimediaOriginalFallback(THUMB, () => true, run)).resolves.toBe(ORIGINAL);
    expect(run.mock.calls.map((c) => c[0])).toStrictEqual([THUMB, ORIGINAL]);
  });

  it("does not retry when shouldRetry is false", async () => {
    const err = new Error("nope");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(withWikimediaOriginalFallback(THUMB, () => false, run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-Wikimedia URL even when shouldRetry is true", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback("https://example.com/a.jpg", () => true, run),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a look-alike host such as evilwikimedia.org (exact-host match)", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://evilwikimedia.org/wikipedia/commons/thumb/e/e7/x.jpg/800px-x.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an incomplete thumbnail-shaped URL whose tail is not a <width>px- rendition", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Foo.jpg/notarendition",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite when the rendition filename does not match the source file", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Foo.jpg/800px-Bar.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a malformed rendition with an unanchored width token (not-a-800px-Foo.jpg)", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Foo.jpg/not-a-800px-Foo.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rewrites an SVG rasterization rendition (Foo.svg -> 800px-Foo.svg.png)", async () => {
    const run = vi.fn(async (url: string) => {
      if (url.includes("/thumb/")) {
        throw new Error("400");
      }
      return url;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.svg/800px-Foo.svg.png",
        () => true,
        run,
      ),
    ).resolves.toBe("https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.svg");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite a thumbnail path missing the md5 hash-shard dirs (thumb/File/rendition)", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/Foo.jpg/800px-Foo.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite when the 2-char shard is not prefixed by the 1-char shard (a/bc)", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/bc/Foo.jpg/800px-Foo.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite when a hash-shard dir is not lowercase hex (Z/Z0)", async () => {
    const err = new Error("400");
    const run = vi.fn(async () => {
      throw err;
    });
    await expect(
      withWikimediaOriginalFallback(
        "https://upload.wikimedia.org/wikipedia/commons/thumb/Z/Z0/Foo.jpg/800px-Foo.jpg",
        () => true,
        run,
      ),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("surfaces the ORIGINAL error when the fallback fetch also fails", async () => {
    const firstErr = new Error("thumbnail 400");
    const run = vi.fn(async (url: string) => {
      throw url === THUMB ? firstErr : new Error("original 404");
    });
    await expect(withWikimediaOriginalFallback(THUMB, () => true, run)).rejects.toBe(firstErr);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
