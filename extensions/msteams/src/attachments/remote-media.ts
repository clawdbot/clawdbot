import { saveResponseMedia, type SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { inferPlaceholder } from "./shared.js";
import type { MSTeamsInboundMedia } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Direct fetch path used when the caller's `fetchImpl` has already validated
 * the URL against a hostname allowlist (for example `safeFetchWithPolicy`).
 *
 * Bypasses the strict SSRF dispatcher on `readRemoteMediaBuffer` because:
 *   1. The pinned undici dispatcher used by `readRemoteMediaBuffer` is incompatible
 *      with Node 24+'s built-in undici v7 (fails with "invalid onRequestStart
 *      method"), which silently breaks SharePoint/OneDrive downloads. See
 *      issue #63396.
 *   2. SSRF protection is already enforced by the caller's `fetchImpl`
 *      (`safeFetch` validates every redirect hop against the hostname
 *      allowlist before following).
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
   * Opt into a direct fetch path that bypasses `readRemoteMediaBuffer`'s strict
   * SSRF dispatcher. Required for SharePoint/OneDrive downloads on Node 24+
   * (see issue #63396). Only safe when the supplied `fetchImpl` has already
   * validated the URL against a hostname allowlist.
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
