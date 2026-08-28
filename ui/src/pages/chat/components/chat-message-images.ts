import { html, noChange, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { until } from "lit/directives/until.js";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { showToast } from "../../../lib/toast.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
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
const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;
type ManagedImageVariant = "full" | "thumbnail";

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
          opts?.resourceBasePath,
          opts?.authToken,
          opts?.onRequestUpdate,
        )
      : { status: "available" as const };
    if (availability.status !== "available") {
      return [];
    }
    const displayUrl = canProxyLocalImage
      ? buildAssistantAttachmentUrl(img.url, opts?.resourceBasePath, availability.mediaTicket)
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
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      openResolvedImage(opts?.onOpenImage, previewUrl, title, undefined, requestVersion);
      return;
    }

    const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
      img.displayUrl,
      opts,
      img.artifactId,
      "full",
    );
    const cached = readManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full");
    if (cached) {
      const release = opts?.onOpenImage ? retainManagedImageBlobUrl(cacheKey) : undefined;
      openResolvedImage(opts?.onOpenImage, cached, title, release, requestVersion);
      return;
    }

    if (!opts?.onOpenImage) {
      const pendingWindow = reserveExternalWindowForDeferredNavigation();
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
        .then((freshUrl) => {
          const safeUrl = freshUrl
            ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
            : null;
          if (!safeUrl) {
            pendingWindow?.close();
            showToast({ message: t("chat.imageLightbox.loadFailed") });
          } else if (pendingWindow) {
            pendingWindow.location.replace(safeUrl);
          } else {
            openExternalUrlSafe(safeUrl, { allowDataImage: true });
          }
        })
        .catch(() => {
          pendingWindow?.close();
          showToast({ message: t("chat.imageLightbox.loadFailed") });
        });
      return;
    }
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
      .then((freshUrl) => {
        if (!freshUrl) {
          showToast({ message: t("chat.imageLightbox.loadFailed") });
          return;
        }
        const release = cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
        openResolvedImage(opts.onOpenImage, freshUrl, title, release, requestVersion);
      })
      .catch(() => showToast({ message: t("chat.imageLightbox.loadFailed") }));
  };

  const renderImageElement = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const managed = isManagedOutgoingImageSource(img.displayUrl);
    // Upscale genuinely tiny sources enough to read and operate without
    // stretching every transcript image into a fixed-size tile.
    const imageClass =
      img.width !== undefined && img.width < MIN_CHAT_IMAGE_PREVIEW_WIDTH
        ? "chat-message-image chat-message-image--small"
        : "chat-message-image";
    return html`
      <span class="chat-image-frame ${managed ? "chat-image-frame--managed" : ""}">
        <button
          type="button"
          class="chat-message-image-button"
          aria-label=${t("chat.imageLightbox.open", { title })}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            openImage(img, previewUrl);
          }}
        >
          <img
            src=${previewUrl}
            alt=${title}
            class=${imageClass}
            width=${img.width ?? nothing}
            height=${img.height ?? nothing}
          />
        </button>
        ${managed ? renderManagedImageActions(img, opts) : nothing}
      </span>
    `;
  };

  const renderImage = (img: RenderableImageBlock) => {
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      return renderImageElement(img, img.displayUrl);
    }
    return renderManagedImageResource(img, opts, renderImageElement);
  };

  const layoutClasses = [
    "chat-message-images",
    images.length === 1 ? "chat-message-images--single" : "chat-message-images--gallery",
    images.length === 2 || images.length === 4 ? "chat-message-images--two-column" : "",
    images.length === 5 ? "chat-message-images--five" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html` <div class=${layoutClasses}>${images.map((img) => renderImage(img))}</div> `;
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
  variant: ManagedImageVariant = "thumbnail",
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${buildManagedOutgoingImageVariantUrl(source, variant, opts?.resourceBasePath)}::${authToken}::${artifactId?.trim() ?? ""}`;
}

function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): string | undefined {
  return readManagedImageBlobUrl(
    resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId, variant),
  );
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): Promise<string | null> {
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId, variant);
  const resource = observeChatMediaResource<string | null>(
    "managed-image",
    cacheKey,
    opts?.onRequestUpdate,
    `${buildManagedOutgoingImageVariantUrl(source, variant, opts?.resourceBasePath)}::${artifactId?.trim() ?? ""}`,
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
      const blob = await fetchManagedOutgoingImageBlob(
        source,
        opts,
        artifactId,
        variant,
        controller,
      );
      if (!blob) {
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

function buildManagedOutgoingImageVariantUrl(
  source: string,
  variant: ManagedImageVariant,
  resourceBasePath?: string,
): string {
  try {
    const parsed = new URL(source, window.location.origin);
    parsed.pathname = parsed.pathname.replace(/\/(?:full|thumbnail)$/u, `/${variant}`);
    if (/^https?:\/\//iu.test(source)) {
      return parsed.href;
    }
    const normalizedBasePath = normalizeBasePath(resourceBasePath ?? "");
    const pathname =
      normalizedBasePath &&
      (parsed.pathname === normalizedBasePath ||
        parsed.pathname.startsWith(`${normalizedBasePath}/`))
        ? parsed.pathname
        : `${normalizedBasePath}${parsed.pathname}`;
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return source.replace(/\/(?:full|thumbnail)(?=$|[?#])/u, `/${variant}`);
  }
}

async function fetchManagedOutgoingImageBlob(
  source: string,
  opts: ImageRenderOptions | undefined,
  artifactId: string | undefined,
  variant: ManagedImageVariant,
  controller = new AbortController(),
): Promise<Blob | null> {
  const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
  const artifactDownload =
    requesterSessionKey && artifactId && opts?.resolveArtifactDownload
      ? await opts
          .resolveArtifactDownload({ sessionKey: requesterSessionKey, artifactId })
          .catch(() => null)
      : null;
  const requestUrl = buildManagedOutgoingImageVariantUrl(
    artifactDownload?.url ?? source,
    variant,
    opts?.resourceBasePath,
  );
  const headers = new Headers({ Accept: "image/*" });
  const authToken = opts?.authToken?.trim();
  if (!artifactDownload && authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  if (!artifactDownload && requesterSessionKey) {
    headers.set("x-openclaw-requester-session-key", requesterSessionKey);
  }
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("managed outgoing image fetch timed out", "TimeoutError"));
  }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    // Root deployments use /api directly; subpath deployments expose the same
    // media route beneath the configured Control UI base path.
    const response = await fetch(requestUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function readManagedOutgoingImageBlob(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
): Promise<Blob> {
  const blobUrl = await resolveManagedOutgoingImageBlobUrl(source, opts, artifactId, "full");
  if (!blobUrl) {
    throw new Error("managed image is unavailable");
  }
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("managed image response is invalid");
  }
  return blob;
}

function imageDownloadFileName(title: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1] || "img";
  const stem = Array.from(title, (character) =>
    character.codePointAt(0)! <= 0x1f || '<>:"/\\|?*'.includes(character) ? "-" : character,
  )
    .join("")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .replace(/[. -]+$/u, "")
    .slice(0, 120);
  return `${stem || "generated-image"}.${/^[a-z0-9.+-]{1,12}$/u.test(extension) ? extension : "img"}`;
}

function downloadImageBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("image conversion context is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (converted) =>
          converted ? resolve(converted) : reject(new Error("image conversion failed")),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

function renderManagedImageActions(
  image: RenderableImageBlock,
  opts: ImageRenderOptions | undefined,
) {
  const title = image.alt?.trim() || t("chat.imageLightbox.untitled");
  const download = async () => {
    try {
      const blob = await readManagedOutgoingImageBlob(image.displayUrl, opts, image.artifactId);
      downloadImageBlob(blob, imageDownloadFileName(title, blob.type));
    } catch {
      showToast({ message: t("chat.imageLightbox.downloadFailed") });
    }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("image clipboard is unavailable");
      }
      const png = readManagedOutgoingImageBlob(image.displayUrl, opts, image.artifactId).then(
        convertImageBlobToPng,
      );
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      showToast({ message: t("common.copied") });
    } catch {
      showToast({ message: t("chat.imageLightbox.copyFailed") });
    }
  };
  return html`
    <span class="chat-image-actions">
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.imageLightbox.download")}
        aria-label=${t("chat.imageLightbox.download")}
        @click=${() => void download()}
      >
        ${icons.download}
      </button>
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.imageLightbox.copy")}
        aria-label=${t("chat.imageLightbox.copy")}
        @click=${() => void copy()}
      >
        ${icons.copy}
      </button>
    </span>
  `;
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
