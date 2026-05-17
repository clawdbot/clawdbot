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
    optimizeImages?: boolean;
  } = {},
) {
  const readFile = options.mediaAccess?.readFile ?? options.mediaReadFile;
  const localRoots =
    options.mediaAccess?.localRoots?.length && options.mediaAccess.localRoots.length > 0
      ? options.mediaAccess.localRoots
      : options.mediaLocalRoots && options.mediaLocalRoots.length > 0
        ? options.mediaLocalRoots
        : undefined;
  const sharedOptions = {
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.optimizeImages !== undefined ? { optimizeImages: options.optimizeImages } : {}),
  };
  return await loadWebMedia(
    mediaUrl,
    readFile
      ? {
          ...sharedOptions,
          localRoots: "any",
          readFile,
          hostReadCapability: true,
        }
      : {
          ...sharedOptions,
          ...(localRoots ? { localRoots } : {}),
        },
  );
}
