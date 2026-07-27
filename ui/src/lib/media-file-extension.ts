// Browser-safe media filename extension parsing shared by Control UI renderers.

/** Returns a lowercase extension without the leading dot. */
export function getMediaFileExtension(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  let filename: string;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const pathname = new URL(trimmed).pathname;
      filename = pathname.slice(pathname.lastIndexOf("/") + 1);
      try {
        // Match media-core: decode only the filename and keep encoded path
        // separators as filename data instead of turning them into boundaries.
        const decodable = filename.replace(/%2f/gi, "%252F").replace(/%5c/gi, "%255C");
        filename = decodeURIComponent(decodable);
      } catch {
        // Preserve the raw filename when its own percent encoding is malformed.
      }
    } else {
      filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
    }
  } catch {
    filename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  }
  return /\.([a-zA-Z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
}
