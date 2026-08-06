// Msteams plugin module implements remote media behavior.
import { saveResponseMedia, type SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { resolveMSTeamsMediaKind } from "./shared.js";
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
  try {
    return await saveResponseMedia(response, {
      sourceUrl: params.url,
      filePathHint: params.filePathHint,
      maxBytes: params.maxBytes,
      fallbackContentType: params.contentTypeHint,
      originalFilename: params.originalFilename,
    });
  } finally {
    // Guarded responses release their pinned dispatcher on EOF or cancel. A
    // storage failure can happen before the body is read, so always cancel it.
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function downloadAndStoreMSTeamsRemoteMedia(params: {
  url: string;
  filePathHint: string;
  maxBytes: number;
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  contentTypeHint?: string;
  kind?: MSTeamsInboundMedia["kind"];
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
    kind:
      params.kind ??
      resolveMSTeamsMediaKind({
        contentType: saved.contentType,
        fileName: params.filePathHint,
      }),
  };
}
