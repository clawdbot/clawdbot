import { html, nothing } from "lit";
import { until } from "lit/directives/until.js";
import { t } from "../../../i18n/index.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachments.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import {
  cacheManagedImageBlobUrl,
  cacheManagedImageBlobUrlMiss,
  hasRecentManagedImageBlobUrlMiss,
  readManagedImageBlobUrl,
  retainManagedImageBlobUrl,
  type ImageBlock,
  type ImageRenderOptions,
  type RenderableImageBlock,
} from "./chat-message-media.ts";

const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const managedImageBlobUrlCache = new Map<string, Promise<string | null>>();

export function resolveRenderableMessageImages(
  images: ImageBlock[],
  opts?: ImageRenderOptions,
): RenderableImageBlock[] {
  return images.flatMap((img) => {
    const isLocalImage = isLocalAssistantAttachmentSource(img.url);
    const canProxyLocalImage =
      isLocalImage && isLocalAttachmentPreviewAllowed(img.url, opts?.localMediaPreviewRoots ?? []);
    if (isLocalImage && !canProxyLocalImage) {
      return [];
    }
    const availability = canProxyLocalImage
      ? resolveAssistantAttachmentAvailability(
          img.url,
          opts?.localMediaPreviewRoots ?? [],
          opts?.basePath,
          opts?.authToken,
          opts?.onRequestUpdate,
        )
      : { status: "available" as const };
    if (availability.status !== "available") {
      return [];
    }
    const displayUrl = canProxyLocalImage
      ? buildAssistantAttachmentUrl(img.url, opts?.basePath, availability.mediaTicket)
      : img.url;
    return [{ ...img, displayUrl }];
  });
}

export function renderMessageImages(images: RenderableImageBlock[], opts?: ImageRenderOptions) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const requestVersion = opts?.onRequestOpenImage?.();
    const managedSource = isManagedOutgoingImageSource(img.displayUrl);
    const cacheKey = managedSource
      ? resolveManagedOutgoingImageBlobUrlCacheKey(img.displayUrl, opts)
      : undefined;
    const previewIsCurrent =
      !managedSource || readManagedOutgoingImageBlobUrl(img.displayUrl, opts) === previewUrl;
    if (previewIsCurrent) {
      const release =
        opts?.onOpenImage && cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
      openResolvedImage(opts?.onOpenImage, previewUrl, title, release, requestVersion);
      return;
    }

    // A managed-image Blob URL may have been evicted after this row rendered.
    // Re-resolve before opening so the modal never receives a revoked URL.
    if (!opts?.onOpenImage) {
      const pendingWindow = reserveExternalWindowForDeferredNavigation();
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts)
        .then((freshUrl) => {
          const safeUrl = freshUrl
            ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
            : null;
          if (!safeUrl) {
            pendingWindow?.close();
          } else if (pendingWindow) {
            pendingWindow.location.replace(safeUrl);
          } else {
            openExternalUrlSafe(safeUrl, { allowDataImage: true });
          }
        })
        .catch(() => pendingWindow?.close());
      return;
    }
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts)
      .then((freshUrl) => {
        if (!freshUrl) {
          return;
        }
        const release = cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
        openResolvedImage(opts.onOpenImage, freshUrl, title, release, requestVersion);
      })
      .catch(() => {});
  };

  const renderImageElement = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    return html`
      <button
        type="button"
        class="chat-message-image-button"
        aria-label=${t("chat.imageLightbox.open", { title })}
        @click=${() => openImage(img, previewUrl)}
      >
        <img
          src=${previewUrl}
          alt=${title}
          class="chat-message-image"
          width=${img.width ?? nothing}
          height=${img.height ?? nothing}
        />
      </button>
    `;
  };

  const renderImage = (img: RenderableImageBlock) => {
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      return renderImageElement(img, img.displayUrl);
    }
    const preview = resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts).then((previewUrl) => {
      if (!previewUrl) {
        return nothing;
      }
      return renderImageElement(img, previewUrl);
    });
    return until(preview, nothing);
  };

  return html` <div class="chat-message-images">${images.map((img) => renderImage(img))}</div> `;
}

function isManagedOutgoingImageSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("/api/chat/media/outgoing/")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

function resolveManagedOutgoingImageRequesterSessionKey(source: string): string | null {
  try {
    const parsed = new URL(source, window.location.origin);
    const parts = parsed.pathname.split("/");
    const encodedSessionKey = parts[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ImageRenderOptions,
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${source}::${authToken}`;
}

function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
): string | undefined {
  return readManagedImageBlobUrl(resolveManagedOutgoingImageBlobUrlCacheKey(source, opts));
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
): Promise<string | null> {
  const authToken = opts?.authToken?.trim() ?? "";
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts);
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    return cached;
  }
  if (hasRecentManagedImageBlobUrlMiss(cacheKey)) {
    return null;
  }
  let pending = managedImageBlobUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
      const headers = new Headers({ Accept: "image/*" });
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }
      if (requesterSessionKey) {
        headers.set("x-openclaw-requester-session-key", requesterSessionKey);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(
          new DOMException("managed outgoing image fetch timed out", "TimeoutError"),
        );
      }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
      try {
        // Managed media is a Gateway API at the origin root. Rebasing it under
        // the Control UI mount path serves the HTML shell instead of image bytes.
        const res = await fetch(source, {
          method: "GET",
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          cacheManagedImageBlobUrlMiss(cacheKey);
          return null;
        }
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) {
          cacheManagedImageBlobUrlMiss(cacheKey);
          return null;
        }
        const blobUrl = URL.createObjectURL(blob);
        cacheManagedImageBlobUrl(cacheKey, blobUrl);
        return blobUrl;
      } catch {
        // The render path treats a missing preview as `nothing`; never reject
        // its `until` promise for an optional image fetch or body failure.
        cacheManagedImageBlobUrlMiss(cacheKey);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      managedImageBlobUrlCache.delete(cacheKey);
    });
    managedImageBlobUrlCache.set(cacheKey, pending);
  }
  return pending;
}
