import { html, noChange, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
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
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  observeChatMediaResourceSubscriber,
  readManagedImageBlobUrl,
  releaseChatMediaResourceSubscriber,
  retainManagedImageBlobUrl,
  scheduleChatMediaResourceRefresh,
  trimManagedImageMissResources,
  type ChatMediaResource,
  type ImageBlock,
  type ImageRenderOptions,
  type RenderableImageBlock,
} from "./chat-message-media.ts";

const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MANAGED_OUTGOING_IMAGE_RETRY_MS = 5_000;

class ManagedImageResourceDirective extends AsyncDirective {
  private cacheKey: string | undefined;
  private image: RenderableImageBlock | undefined;
  private options: ImageRenderOptions | undefined;
  private renderImageElement:
    | ((image: RenderableImageBlock, previewUrl: string) => TemplateResult)
    | undefined;
  private onRequestUpdate: (() => void) | undefined;
  private readonly requestUpdate = () => this.onRequestUpdate?.();

  override render(
    image: RenderableImageBlock,
    options: ImageRenderOptions | undefined,
    renderImageElement: (image: RenderableImageBlock, previewUrl: string) => TemplateResult,
  ) {
    this.image = image;
    this.options = options;
    this.renderImageElement = renderImageElement;
    if (!this.isConnected) {
      releaseChatMediaResourceSubscriber(this.requestUpdate);
      this.cacheKey = undefined;
      this.onRequestUpdate = options?.onRequestUpdate;
      return noChange;
    }

    const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
      image.displayUrl,
      options,
      image.artifactId,
    );
    if (
      (this.cacheKey !== undefined && this.cacheKey !== cacheKey) ||
      this.onRequestUpdate !== options?.onRequestUpdate
    ) {
      releaseChatMediaResourceSubscriber(this.requestUpdate);
    }
    this.cacheKey = cacheKey;
    this.onRequestUpdate = options?.onRequestUpdate;

    // A transcript shares one pane callback across many guarded rows. Lit owns
    // each image part, so only disconnecting that part may release its resource.
    if (this.onRequestUpdate) {
      observeChatMediaResourceSubscriber(this.onRequestUpdate, this.requestUpdate);
    }
    const subscriptionOptions = this.onRequestUpdate
      ? { ...options, onRequestUpdate: this.requestUpdate }
      : options;
    const preview = resolveManagedOutgoingImageBlobUrl(
      image.displayUrl,
      subscriptionOptions,
      image.artifactId,
    ).then((previewUrl) => (previewUrl ? renderImageElement(image, previewUrl) : nothing));
    return until(preview, nothing);
  }

  protected override disconnected() {
    releaseChatMediaResourceSubscriber(this.requestUpdate);
  }

  protected override reconnected() {
    if (this.image && this.renderImageElement) {
      // Guarded transcript rows can skip their next pane render. Reinstall the
      // image promise and its subscriber directly when Lit reconnects its part.
      this.setValue(this.render(this.image, this.options, this.renderImageElement));
    }
  }
}

const renderManagedImageResource = directive(ManagedImageResourceDirective);

export function resolveRenderableMessageImages(
  images: ImageBlock[],
  opts?: ImageRenderOptions,
): RenderableImageBlock[] {
  return images.flatMap((img) => {
    const isLocalImage = isLocalAssistantAttachmentSource(img.url);
    const localMediaPreviewRoots = opts?.localMediaPreviewRoots ?? [];
    // Until bootstrap supplies roots, let authenticated Gateway metadata decide.
    const canProxyLocalImage =
      isLocalImage &&
      (localMediaPreviewRoots.length === 0 ||
        isLocalAttachmentPreviewAllowed(img.url, localMediaPreviewRoots));
    if (isLocalImage && !canProxyLocalImage) {
      return [];
    }
    const availability = canProxyLocalImage
      ? resolveAssistantAttachmentAvailability(
          img.url,
          localMediaPreviewRoots,
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
      ? resolveManagedOutgoingImageBlobUrlCacheKey(img.displayUrl, opts, img.artifactId)
      : undefined;
    const previewIsCurrent =
      !managedSource ||
      readManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId) === previewUrl;
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
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId)
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
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId)
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
    return renderManagedImageResource(img, opts, renderImageElement);
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
  artifactId?: string,
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${source}::${authToken}::${artifactId?.trim() ?? ""}`;
}

function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
): string | undefined {
  return readManagedImageBlobUrl(
    resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId),
  );
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
): Promise<string | null> {
  const authToken = opts?.authToken?.trim() ?? "";
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId);
  const resource = observeChatMediaResource<string | null>(
    "managed-image",
    cacheKey,
    opts?.onRequestUpdate,
    `${source}::${artifactId?.trim() ?? ""}`,
  );
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    resource.value = cached;
    resource.retryAttempted = false;
    resource.unavailableAt = undefined;
    return cached;
  }
  if (resource.value === null) {
    if (
      resource.retryAttempted ||
      resource.unavailableAt === undefined ||
      Date.now() - resource.unavailableAt < MANAGED_OUTGOING_IMAGE_RETRY_MS
    ) {
      return null;
    }
    resource.retryAttempted = true;
    resource.value = undefined;
  }
  if (!resource.pending) {
    const controller = new AbortController();
    resource.abortController = controller;
    const pending = (async () => {
      const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
      const artifactDownload =
        requesterSessionKey && artifactId && opts?.resolveArtifactDownload
          ? await opts
              .resolveArtifactDownload({ sessionKey: requesterSessionKey, artifactId })
              .catch(() => null)
          : null;
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      const requestUrl = artifactDownload?.url ?? source;
      const headers = new Headers({ Accept: "image/*" });
      if (!artifactDownload && authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }
      if (!artifactDownload && requesterSessionKey) {
        headers.set("x-openclaw-requester-session-key", requesterSessionKey);
      }
      const timeout = setTimeout(() => {
        controller.abort(
          new DOMException("managed outgoing image fetch timed out", "TimeoutError"),
        );
      }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
      try {
        // Managed media is a Gateway API at the origin root. Rebasing it under
        // the Control UI mount path serves the HTML shell instead of image bytes.
        const res = await fetch(requestUrl, {
          method: "GET",
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          return markManagedOutgoingImageUnavailable(resource);
        }
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) {
          return markManagedOutgoingImageUnavailable(resource);
        }
        if (!isChatMediaResourceCurrent(resource)) {
          return null;
        }
        const blobUrl = URL.createObjectURL(blob);
        cacheManagedImageBlobUrl(cacheKey, blobUrl);
        resource.value = blobUrl;
        resource.retryAttempted = false;
        resource.unavailableAt = undefined;
        return blobUrl;
      } catch {
        // The render path treats a missing preview as `nothing`; never reject
        // its `until` promise for an optional image fetch or body failure.
        return markManagedOutgoingImageUnavailable(resource);
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      if (resource.abortController === controller) {
        resource.abortController = undefined;
      }
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      trimManagedImageMissResources();
      notifyChatMediaResourceSubscribers(resource);
    });
    resource.pending = pending;
  }
  return resource.pending;
}

function markManagedOutgoingImageUnavailable(resource: ChatMediaResource<string | null>): null {
  if (!isChatMediaResourceCurrent(resource)) {
    return null;
  }
  resource.value = null;
  resource.unavailableAt = Date.now();
  if (!resource.retryAttempted) {
    scheduleChatMediaResourceRefresh(resource, Date.now() + MANAGED_OUTGOING_IMAGE_RETRY_MS, () => {
      if (resource.value !== null) {
        return;
      }
      // A missing preview gets one lifecycle-owned retry, never a polling loop.
      resource.retryAttempted = true;
      resource.value = undefined;
      resource.unavailableAt = undefined;
      notifyChatMediaResourceSubscribers(resource);
    });
  }
  return null;
}
