// Media Core module implements stored file name behavior.

const EMBEDDED_MEDIA_ID_RE =
  /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function storedFileBasename(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Restores the caller-facing filename from media-store paths with embedded UUID suffixes. */
export function extractOriginalFilename(filePath: string): string {
  const basename = storedFileBasename(filePath);
  if (!basename) {
    return "file.bin";
  }

  const extensionIndex = basename.lastIndexOf(".");
  const hasExtension = extensionIndex > 0;
  const extension = hasExtension ? basename.slice(extensionIndex) : "";
  const nameWithoutExtension = hasExtension ? basename.slice(0, extensionIndex) : basename;
  const match = nameWithoutExtension.match(EMBEDDED_MEDIA_ID_RE);
  return match?.[1] ? `${match[1]}${extension}` : basename;
}
