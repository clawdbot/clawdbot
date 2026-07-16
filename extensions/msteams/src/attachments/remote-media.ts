import { readResponseWithLimit } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "../../runtime-api.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { inferPlaceholder } from "./shared.js";
import type { MSTeamsInboundMedia } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchedRemoteMedia = {
  buffer: Buffer;
  contentType?: string;
};

/**
 * Direct fetch path used when the caller's `fetchImpl` has already validated
 * the URL against a hostname allowlist (for example `safeFetchWithPolicy`).
 *
 * Bypasses the strict SSRF dispatcher on `fetchRemoteMedia` because:
 *   1. The pinned undici dispatcher used by `fetchRemoteMedia` is incompatible
 *      with Node 24+'s built-in undici v7 (fails with "invalid onRequestStart
 *      method"), which silently breaks SharePoint/OneDrive downloads. See
 *      issue #63396.
 *   2. SSRF protection is already enforced by the caller's `fetchImpl`
 *      (`safeFetch` validates every redirect hop against the hostname
 *      allowlist before following).
 */
async function fetchRemoteMediaDirect(params: {
  url: string;
  fetchImpl: FetchLike;
  maxBytes: number;
}): Promise<FetchedRemoteMedia> {
  const response = await params.fetchImpl(params.url, { redirect: "follow" });
  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    throw new Error(`HTTP ${response.status}${statusText}`);
  }

  // Enforce the max-bytes cap before buffering the full body so a rogue
  // response cannot drive RSS usage past the configured limit.
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > params.maxBytes) {
      throw new Error(`content length ${length} exceeds maxBytes ${params.maxBytes}`);
    }
  }

  const buffer = await readResponseWithLimit(response, params.maxBytes, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`payload size ${size} exceeds maxBytes ${maxBytes}`),
  });

  return {
    buffer,
    contentType: response.headers.get("content-type") ?? undefined,
  };
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
   * Opt into a direct fetch path that bypasses `fetchRemoteMedia`'s strict
   * SSRF dispatcher. Required for SharePoint/OneDrive downloads on Node 24+
   * (see issue #63396). Only safe when the supplied `fetchImpl` has already
   * validated the URL against a hostname allowlist.
   */
  useDirectFetch?: boolean;
}): Promise<MSTeamsInboundMedia> {
  let fetched: FetchedRemoteMedia;
  if (params.useDirectFetch && params.fetchImpl) {
    fetched = await fetchRemoteMediaDirect({
      url: params.url,
      fetchImpl: params.fetchImpl,
      maxBytes: params.maxBytes,
    });
  } else {
    fetched = await getMSTeamsRuntime().channel.media.fetchRemoteMedia({
      url: params.url,
      fetchImpl: params.fetchImpl,
      filePathHint: params.filePathHint,
      maxBytes: params.maxBytes,
      ssrfPolicy: params.ssrfPolicy,
    });
  }
  const mime = await getMSTeamsRuntime().media.detectMime({
    buffer: fetched.buffer,
    headerMime: fetched.contentType ?? params.contentTypeHint,
    filePath: params.filePathHint,
  });
  const originalFilename = params.preserveFilenames ? params.filePathHint : undefined;
  const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    mime ?? params.contentTypeHint,
    "inbound",
    params.maxBytes,
    originalFilename,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder:
      params.placeholder ??
      inferPlaceholder({ contentType: saved.contentType, fileName: params.filePathHint }),
  };
}
