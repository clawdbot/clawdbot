/**
 * Wikimedia thumbnail fallback.
 *
 * Wikimedia only serves pre-rendered thumbnails at a whitelist of widths; a
 * request for any other width returns HTTP 400 ("Use thumbnail sizes listed on
 * ..."). The original (non-thumbnail) file, however, is always served. When a
 * thumbnail fetch fails with a 400 we can retry the original file URL.
 */

/**
 * Rewrites an `upload.wikimedia.org` thumbnail URL to its original
 * (non-thumbnail) file URL. Thumbnail URLs look like
 * `/wikipedia/<project>/thumb/<a>/<ab>/<File>/<width>px-<File>`; the original
 * drops the `thumb` segment and the trailing `<width>px-...` rendition:
 * `/wikipedia/<project>/<a>/<ab>/<File>`.
 *
 * Returns `undefined` when `url` is not a Wikimedia thumbnail URL. The host is
 * matched EXACTLY (`endsWith("wikimedia.org")` would also accept
 * `evilwikimedia.org`), and the rewrite is derived purely from the same file's
 * path, so it can never point at an attacker-controlled origin.
 */
function resolveWikimediaOriginalUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "upload.wikimedia.org") {
    return undefined;
  }
  // Require the COMPLETE canonical thumbnail layout, not just a "thumb" segment:
  //   /wikipedia/<project>/thumb/<a>/<ab>/<File>/<width>px-<File>
  // where <a>/<ab> are the 1- and 2-char lowercase-hex md5 shards of <File> (and
  // <ab> starts with <a>). The original drops the "thumb" segment and the trailing
  // rendition: /wikipedia/<project>/<a>/<ab>/<File>. Validating the shards rejects
  // incomplete thumbnail-shaped paths (e.g. `/wikipedia/commons/thumb/Foo.jpg/800px-Foo.jpg`,
  // which has no shard dirs) so a 400 on such a URL never rewrites to an unrelated file.
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 7 || parts[0] !== "wikipedia" || parts[2] !== "thumb") {
    return undefined;
  }
  const project = parts[1];
  const shard1 = parts[3];
  const shard2 = parts[4];
  const sourceFile = parts[5];
  const rendition = parts[6];
  if (
    project === undefined ||
    shard1 === undefined ||
    shard2 === undefined ||
    sourceFile === undefined ||
    rendition === undefined
  ) {
    return undefined;
  }
  if (!/^[0-9a-f]$/.test(shard1) || !/^[0-9a-f]{2}$/.test(shard2) || !shard2.startsWith(shard1)) {
    return undefined;
  }
  // The width token must be ANCHORED at the start of the rendition, and the source
  // filename must be the rendition's tail (exact, or the source name plus an added
  // rendition extension such as ".png" for SVG rasterization). This rejects malformed
  // layouts like "not-a-800px-Foo.jpg" (unanchored width) and renditions whose filename
  // doesn't match the source ("800px-Bar.jpg").
  const renditionMatch = /^\d+px-(.+)$/.exec(rendition);
  if (renditionMatch === null) {
    return undefined;
  }
  const renditionFile = renditionMatch[1];
  if (renditionFile === undefined) {
    return undefined;
  }
  if (renditionFile !== sourceFile && !renditionFile.startsWith(`${sourceFile}.`)) {
    return undefined;
  }
  return `${parsed.origin}/wikipedia/${project}/${shard1}/${shard2}/${sourceFile}`;
}

/**
 * Runs `run(url)`; if it throws and `shouldRetry(err)` is true and `url` is a
 * Wikimedia thumbnail URL, retries `run(originalUrl)` once. When the retry also
 * fails, the ORIGINAL error is surfaced (the caller asked for `url`, not the
 * derived original), so error reporting is unchanged for genuine failures.
 *
 * The retry decision is keyed off `shouldRetry` (the caller passes an HTTP-400
 * check) and the URL shape — NOT the response body. The managed-media store
 * path drains non-OK response bodies (see `store.remote.runtime.ts`), so the
 * "thumbnail sizes" error text is not observable there; a body-text predicate
 * would leave this fallback dead on the real outgoing-reply path.
 */
export async function withWikimediaOriginalFallback<T>(
  url: string,
  shouldRetry: (err: unknown) => boolean,
  run: (url: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(url);
  } catch (err) {
    if (!shouldRetry(err)) {
      throw err;
    }
    const originalUrl = resolveWikimediaOriginalUrl(url);
    if (originalUrl === undefined) {
      throw err;
    }
    try {
      return await run(originalUrl);
    } catch {
      throw err;
    }
  }
}
