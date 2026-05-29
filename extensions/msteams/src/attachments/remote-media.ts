import { saveResponseMedia, type SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { inferPlaceholder } from "./shared.js";
import type { MSTeamsInboundMedia } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Direct save path used when the caller supplies the already-guarded fetch
 * implementation. This lets Teams-specific auth fallback own the request
 * sequence while keeping redirect and DNS pinning inside `safeFetchWithPolicy`.
 */
async function saveRemoteMediaDirect(params: {
  url: string;
  filePathHint: string;
  fetchImpl: FetchLike;
  maxBytes: number;
  contentTypeHint?: string;
  originalFilename?: string;
}): Promise<SavedRemoteMedia> {
  const response = await params.fetchImpl(params.url, { redirect: "follow" });
  return await saveResponseMedia(response, {
    sourceUrl: params.url,
    filePathHint: params.filePathHint,
    maxBytes: params.maxBytes,
    fallbackContentType: params.contentTypeHint,
    originalFilename: params.originalFilename,
  });
}

export async function downloadAndStoreMSTeamsRemoteMedia(params: {
  url: string;
  filePathHint: string;
  maxBytes: number;
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  contentTypeHint?: string;
  placeholder?: string;
  preserveFilenames?: boolean;
  /**
   * Opt into the Teams-specific guarded fetch path. Only safe when the
   * supplied `fetchImpl` enforces the attachment fetch policy itself.
   */
  useDirectFetch?: boolean;
}): Promise<MSTeamsInboundMedia> {
  const originalFilename = params.preserveFilenames ? params.filePathHint : undefined;
  let saved: SavedRemoteMedia;
  if (params.useDirectFetch && params.fetchImpl) {
    saved = await saveRemoteMediaDirect({
      url: params.url,
      filePathHint: params.filePathHint,
      fetchImpl: params.fetchImpl,
      maxBytes: params.maxBytes,
      contentTypeHint: params.contentTypeHint,
      originalFilename,
    });
  } else {
    saved = await getMSTeamsRuntime().channel.media.saveRemoteMedia({
      url: params.url,
      fetchImpl: params.fetchImpl,
      filePathHint: params.filePathHint,
      maxBytes: params.maxBytes,
      ssrfPolicy: params.ssrfPolicy,
      fallbackContentType: params.contentTypeHint,
      originalFilename,
    });
  }
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder:
      params.placeholder ??
      inferPlaceholder({ contentType: saved.contentType, fileName: params.filePathHint }),
  };
}
