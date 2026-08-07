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
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[0] !== "wikipedia" || parts[2] !== "thumb") {
    return undefined;
  }
  // The last segment must be a genuine width-prefixed rendition OF THE SOURCE FILE
  // (e.g. "Foo.jpg" -> "800px-Foo.jpg", or "Foo.svg" -> "800px-Foo.svg.png"), not an
  // arbitrary extra path segment. That is what makes "drop the last segment" the
  // correct original-file URL; an incomplete thumbnail-shaped URL whose tail is not a
  // "<width>px-...<sourcefile>..." rendition is left alone rather than rewritten.
  const sourceFile = parts[parts.length - 2];
  const rendition = parts[parts.length - 1];
  if (sourceFile === undefined || rendition === undefined) {
    return undefined;
  }
  if (!/\d+px-/.test(rendition) || !rendition.includes(sourceFile)) {
    return undefined;
  }
  const rest = parts.slice(0, 2).concat(parts.slice(3, -1));
  return `${parsed.origin}/${rest.join("/")}`;
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
