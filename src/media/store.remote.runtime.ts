// Lazy-load this boundary to avoid store -> fetch -> store; saveRemoteMedia owns ingestion.
import { getFileExtension } from "@openclaw/media-core/mime";
import {
  fetchWithRuntimeDispatcherOrMockedGlobal,
  type DispatcherAwareRequestInit,
} from "../infra/net/runtime-fetch.js";
import type { LookupFn, resolvePinnedHostname } from "../infra/net/ssrf.js";
import { saveRemoteMedia, type FetchLike } from "./fetch.js";
import type { SavedMedia } from "./store.js";

const REMOTE_MEDIA_TIMEOUT_MS = 30_000;

const fetchWithoutIgnoredBody: FetchLike = async (input, init) => {
  const response = await fetchWithRuntimeDispatcherOrMockedGlobal(
    input,
    init as DispatcherAwareRequestInit,
  );
  if (response.ok) {
    return response;
  }
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export async function saveRemoteMediaForStore(params: {
  source: string;
  headers?: Record<string, string>;
  subdir: string;
  maxBytes: number;
  resolvePinnedHostnameForTest?: typeof resolvePinnedHostname;
}): Promise<SavedMedia> {
  const resolvePinned = params.resolvePinnedHostnameForTest;
  const lookupFn: LookupFn | undefined = resolvePinned
    ? async (hostname, _options) => {
        const pinned = await resolvePinned(hostname);
        return pinned.addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }));
      }
    : undefined;
  const { id, path, size, contentType } = await saveRemoteMedia({
    url: params.source,
    fetchImpl: fetchWithoutIgnoredBody,
    requestInit: params.headers ? { headers: params.headers } : undefined,
    filePathHint: params.source,
    // The store discards this synthetic underscore stem but keeps its extension,
    // preserving the URL-suffix fallback without embedding the remote basename.
    originalFilename: `_${getFileExtension(params.source) ?? ""}`,
    maxBytes: params.maxBytes,
    maxRedirects: 5,
    responseHeaderTimeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
    readIdleTimeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
    subdir: params.subdir,
    ...(lookupFn ? { lookupFn } : {}),
    ...(resolvePinned
      ? { ssrfPolicy: { allowedHostnames: [new URL(params.source).hostname] } }
      : {}),
  });
  return { id, path, size, contentType };
}
