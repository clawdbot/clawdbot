// Serves channel-owned conversation images without exposing media-store paths.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { readMediaBuffer } from "../media/store.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  HTTP_IMAGE_MAX_BYTES,
  resolveHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import { authorizeControlUiSessionOwnerReadRequestOrReply } from "./http-utils.js";

const CHANNEL_AVATAR_CACHE_MAX_ENTRIES = 128;

type ChannelAvatarCacheIndex = {
  reference: string;
  imageKey: string;
};

const channelAvatarIndex = new Map<string, ChannelAvatarCacheIndex>();
const channelAvatarBytes = new Map<string, HttpImageRepresentation>();

const getSessionStoreModule = createLazyRuntimeModule(() => import("./session-utils-store.js"));

function touchChannelAvatarCache(
  sessionKey: string,
  reference: string,
): HttpImageRepresentation | undefined {
  const indexed = channelAvatarIndex.get(sessionKey);
  if (!indexed || indexed.reference !== reference) {
    return undefined;
  }
  const image = channelAvatarBytes.get(indexed.imageKey);
  if (!image) {
    channelAvatarIndex.delete(sessionKey);
    return undefined;
  }
  channelAvatarIndex.delete(sessionKey);
  channelAvatarIndex.set(sessionKey, indexed);
  channelAvatarBytes.delete(indexed.imageKey);
  channelAvatarBytes.set(indexed.imageKey, image);
  return image;
}

async function loadChannelAvatar(
  sessionKey: string,
  reference: string,
): Promise<HttpImageRepresentation | undefined> {
  const cached = touchChannelAvatarCache(sessionKey, reference);
  if (cached) {
    return cached;
  }
  const resolved = await resolveInboundMediaReference(reference);
  if (!resolved) {
    return undefined;
  }
  const stored = await readMediaBuffer(resolved.id, "inbound", HTTP_IMAGE_MAX_BYTES);
  const image = await resolveHttpImageRepresentation(resolved.id, stored.buffer);
  if (!image) {
    return undefined;
  }
  // The ETag is the content hash, so the cache key cannot alias changed bytes
  // even when a session is rerouted to a new media-store reference.
  const imageKey = `${sessionKey}\0${image.etag}`;
  channelAvatarBytes.set(imageKey, image);
  channelAvatarIndex.set(sessionKey, { reference, imageKey });
  pruneMapToMaxSize(channelAvatarBytes, CHANNEL_AVATAR_CACHE_MAX_ENTRIES);
  pruneMapToMaxSize(channelAvatarIndex, CHANNEL_AVATAR_CACHE_MAX_ENTRIES);
  return image;
}

/** Serves the current channel-avatar snapshot for an owner-visible session. */
export async function handleChannelAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    basePath?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  const parsed = parseControlUiResourcePath("channelAvatar", pathname, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestAuth = await authorizeControlUiSessionOwnerReadRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }
  if (!parsed.value) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  let reference: string | undefined;
  try {
    const { entry } = (await getSessionStoreModule()).loadGatewaySessionEntryReadOnly(
      parsed.value,
      { clone: false },
    );
    reference = sessionDeliveryOrigin(entry)?.avatar;
  } catch {
    // Invalid or missing session keys are ordinary route misses.
  }
  if (!reference) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  let image: HttpImageRepresentation | undefined;
  try {
    image = await loadChannelAvatar(parsed.value, reference);
  } catch {
    // The media may have expired or been pruned after the session row was written.
  }
  if (!image) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }
  sendHttpImageResponse({ req, res, image, filename: "channel-avatar" });
  return true;
}
