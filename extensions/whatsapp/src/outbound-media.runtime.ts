import { loadWebMedia } from "openclaw/plugin-sdk/web-media";

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: {
    maxBytes?: number;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  } = {},
) {
  const readFile = options.mediaAccess?.readFile ?? options.mediaReadFile;
  const localRoots =
    options.mediaAccess?.localRoots?.length && options.mediaAccess.localRoots.length > 0
      ? options.mediaAccess.localRoots
      : options.mediaLocalRoots && options.mediaLocalRoots.length > 0
        ? options.mediaLocalRoots
        : undefined;
  return await loadWebMedia(
    mediaUrl,
    readFile
      ? {
          ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
          localRoots: "any",
          readFile,
          hostReadCapability: true,
        }
      : {
          ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
          ...(localRoots ? { localRoots } : {}),
        },
  );
}
