import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "../media/load-options.js";
import { loadWebMedia } from "./web-media.js";

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
};

/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: options.maxBytes,
      mediaAccess: options.mediaAccess,
      mediaLocalRoots: options.mediaLocalRoots,
      mediaReadFile: options.mediaReadFile,
      workspaceDir: options.workspaceDir,
      proxyUrl: options.proxyUrl,
      fetchImpl: options.fetchImpl,
      requestInit: options.requestInit,
      trustExplicitProxyDns: options.trustExplicitProxyDns,
    }),
  );
}
