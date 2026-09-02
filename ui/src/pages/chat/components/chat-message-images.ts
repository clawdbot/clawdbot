import { html, noChange, nothing } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { Directive } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
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
import {
  isManagedOutgoingMediaSource,
  resolveAssistantAttachmentAvailability,
  resolveManagedOutgoingMediaSessionKey,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { renderAssistantAttachmentStatusCard } from "./chat-message-attachment-status.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isCanonicalInboundMediaSource,
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
const CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS = 30_000;
const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;
type ManagedImageVariant = "full" | "thumbnail";

type RetainedInlineImage = {
  status: "retaining";
  previewUrl: string;
  timeout?: ReturnType<typeof setTimeout>;
};

function isInlineImageSource(source: string): boolean {
  return source.startsWith("data:image/") || source.startsWith("blob:");
}

class MessageImageResourceDirective extends AsyncDirective {
  private image: ImageBlock | undefined;
  private options: ImageRenderOptions | undefined;
  private element: HTMLImageElement | undefined;
  private presentationKey = Symbol("image-presentation");
  private retained: RetainedInlineImage | { status: "unavailable" } | undefined;
  private onRequestUpdate: (() => void) | undefined;
  private readonly requestUpdate = () => this.onRequestUpdate?.();
  private readonly onSettled = (event: Event, source: string) => {
    // A removed IMG may finish after denial; it no longer owns displayed pixels.
    const element = event.currentTarget;
    if (
      !this.isConnected ||
      this.image?.url !== source ||
      !(element instanceof HTMLImageElement) ||
      !element.isConnected
    ) {
      return;
    }
    this.element = event.type === "load" ? element : undefined;
    if (
      this.retained?.status === "retaining" &&
      this.element?.getAttribute("src") !== this.retained.previewUrl
    ) {
      if (event.type === "error") {
        this.failRetainedImage();
      } else {
        this.releaseRetainedImage();
      }
    }
  };

  override render(image: ImageBlock, options: ImageRenderOptions | undefined) {
    const previous = this.image;
    if (previous?.url !== image.url || previous?.artifactId !== image.artifactId) {
      this.releaseRetainedImage();
      // The gallery binds the exact submission/slot. Retain only pixels this
      // mounted IMG has loaded, never another pane's cached preview.
      this.retained =
        image.factIndex !== undefined &&
        previous &&
        isInlineImageSource(previous.url) &&
        previous.artifactId === image.artifactId &&
        isCanonicalInboundMediaSource(image.url) &&
        this.element?.getAttribute("src") === previous.url &&
        this.element.naturalWidth > 0
          ? { status: "retaining", previewUrl: previous.url }
          : undefined;
      const inlineReplacement =
        options?.localSubmission &&
        previous &&
        isInlineImageSource(previous.url) &&
        isInlineImageSource(image.url);
      if (!this.retained && !inlineReplacement) {
        this.element = undefined;
        this.presentationKey = Symbol("image-presentation");
      }
      releaseChatMediaResourceSubscriber(this.requestUpdate);
    }
    this.image = image;
    this.options = options;
    if (!this.isConnected) {
      this.releaseRetainedImage();
      releaseChatMediaResourceSubscriber(this.requestUpdate);
      return noChange;
    }
    this.onRequestUpdate = options?.onRequestUpdate;

    // Lit owns each image part. Reparent its stable subscription when the pane
    // callback changes without discarding its loaded resource.
    if (this.onRequestUpdate) {
      observeChatMediaResourceSubscriber(this.onRequestUpdate, this.requestUpdate);
    } else {
      releaseChatMediaResourceSubscriber(this.requestUpdate);
    }
    const subscriptionOptions = this.onRequestUpdate
      ? { ...options, onRequestUpdate: this.requestUpdate }
      : options;
    const availability = resolveAssistantAttachmentAvailability(
      image.url,
      options?.localMediaPreviewRoots ?? [],
      options?.resourceBasePath,
      options?.authToken,
      subscriptionOptions?.onRequestUpdate,
    );
    const decodeFailed = this.retained?.status === "unavailable";
    // Tickets authorize new reads, not already decoded pixels. Only this
    // mounted image can survive an unconfirmed renewal; denial still clears it.
    const unconfirmed =
      availability.status === "checking" ||
      (availability.status === "unavailable" && availability.unconfirmed);
    const displayUrl =
      availability.status === "available"
        ? buildAssistantAttachmentUrl(
            image.url,
            options?.resourceBasePath,
            availability.mediaTicket,
          )
        : unconfirmed
          ? this.element?.getAttribute("src")
          : undefined;
    if (!displayUrl || decodeFailed) {
      this.element = undefined;
      if (!decodeFailed) {
        this.releaseRetainedImage();
      }
      const reason =
        availability.status === "unavailable"
          ? availability.reason
          : decodeFailed
            ? t("chat.imageLightbox.loadFailed")
            : undefined;
      return renderAssistantAttachmentStatusCard({
        label: image.fileName ?? image.alt ?? t("chat.imageLightbox.untitled"),
        badge: reason === undefined ? "" : t("chat.attachments.unavailable"),
        reason,
        onRetry:
          !decodeFailed && availability.status === "unavailable" && availability.recoverable
            ? () =>
                retryAssistantAttachmentAvailability(
                  image.url,
                  options?.resourceBasePath,
                  options?.authToken,
                  subscriptionOptions?.onRequestUpdate,
                )
            : undefined,
      });
    }
    const renderable = { ...image, displayUrl };
    if (!isManagedOutgoingMediaSource(displayUrl)) {
      const retained = this.retained;
      if (
        availability.status === "available" &&
        retained?.status === "retaining" &&
        retained.timeout === undefined
      ) {
        // IMG keeps its current decoded request while the new src loads. One
        // native load/error boundary replaces the detached decode preloader.
        retained.timeout = setTimeout(
          () => this.failRetainedImage(),
          CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS,
        );
      }
      return this.present(this.renderImageElement(renderable, displayUrl, options));
    }
    // Keep this render's callbacks when the image resolves, not later directive options.
    const preview = resolveManagedOutgoingImageBlobUrl(
      displayUrl,
      subscriptionOptions,
      image.artifactId,
    ).then((previewUrl) =>
      previewUrl ? this.renderImageElement(renderable, previewUrl, options) : nothing,
    );
    return this.present(until(preview, nothing));
  }

  private renderImageElement(
    img: RenderableImageBlock,
    previewUrl: string,
    opts: ImageRenderOptions | undefined,
  ) {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const managed = isManagedOutgoingMediaSource(img.displayUrl);
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
            openMessageImage(img, previewUrl, opts);
          }}
        >
          <img
            @load=${(event: Event) => this.onSettled(event, img.url)}
            @error=${(event: Event) => this.onSettled(event, img.url)}
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
  }

  private releaseRetainedImage() {
    const retained = this.retained;
    this.retained = undefined;
    if (retained?.status === "retaining") {
      clearTimeout(retained.timeout);
    }
  }

  private failRetainedImage() {
    this.releaseRetainedImage();
    this.retained = { status: "unavailable" };
    this.refreshImage();
  }

  private refreshImage() {
    if (this.isConnected && this.image) {
      this.setValue(this.render(this.image, this.options));
    }
  }

  private present(value: unknown) {
    return html`${keyed(this.presentationKey, value)}`;
  }

  protected override disconnected() {
    this.releaseRetainedImage();
    this.element = undefined;
    this.presentationKey = Symbol("image-presentation");
    releaseChatMediaResourceSubscriber(this.requestUpdate);
  }

  protected override reconnected() {
    // Guarded rows may skip the next pane render; reconnect their own resource.
    this.refreshImage();
  }
}

const renderMessageImageResource = directive(MessageImageResourceDirective);

function openMessageImage(
  img: RenderableImageBlock,
  previewUrl: string,
  opts: ImageRenderOptions | undefined,
) {
  const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
  const requestVersion = opts?.onRequestOpenImage?.();
  if (!isManagedOutgoingMediaSource(img.displayUrl)) {
    openResolvedImage(opts?.onOpenImage, previewUrl, title, undefined, requestVersion);
    return;
  }

  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
    img.displayUrl,
    opts,
    img.artifactId,
    "full",
  );
  const cached = readManagedImageBlobUrl(cacheKey);
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
}

class MessageImagesDirective extends Directive {
  private slots: { image: ImageBlock; key: symbol }[] = [];
  private scope = "";
  private canonicalMessageKey: string | undefined;
  private localSubmission = false;

  override render(images: ImageBlock[], opts?: ImageRenderOptions) {
    const scope = JSON.stringify([
      opts?.connectionEpoch,
      opts?.authToken?.trim(),
      opts?.resourceBasePath,
    ]);
    // Custody keeps local ownership; imported history must end it even when
    // the outer row reuses the same submission key.
    const continuing =
      this.scope === scope &&
      (!this.localSubmission || opts?.localSubmission !== false) &&
      (this.canonicalMessageKey === opts?.canonicalMessageKey ||
        (this.localSubmission && !this.canonicalMessageKey));
    const localSubmission = continuing ? this.localSubmission : opts?.localSubmission === true;
    // Fact positions preserve selected image order, even when hooks reorder
    // content blocks. Partial/ambiguous receipts cannot borrow pixels.
    const adoptingSlots =
      continuing &&
      localSubmission &&
      images.length === this.slots.length &&
      this.slots.every(({ image }) => isInlineImageSource(image.url)) &&
      images.every((image) => image.factIndex !== undefined);
    const previousImages = adoptingSlots
      ? images.toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0))
      : this.slots.map(({ image }) => image);
    const previousSlots = new Map(
      previousImages.map((image, index) => [image.factIndex, this.slots[index]?.key]),
    );
    this.slots = images.map((image, index) => {
      const slot = this.slots[index];
      const previous =
        image.factIndex !== undefined
          ? previousSlots.get(image.factIndex)
          : slot?.image.factIndex === undefined
            ? slot?.key
            : undefined;
      return { image, key: (continuing && previous) || Symbol("image-slot") };
    });
    this.scope = scope;
    this.canonicalMessageKey = opts?.canonicalMessageKey;
    this.localSubmission =
      localSubmission &&
      !(opts?.canonicalMessageKey && images.every((image) => image.factIndex !== undefined));
    if (!images.length) {
      return nothing;
    }
    const layoutClasses = [
      "chat-message-images",
      images.length === 1 ? "chat-message-images--single" : "chat-message-images--gallery",
      images.length === 2 || images.length === 4 ? "chat-message-images--two-column" : "",
      images.length === 5 ? "chat-message-images--five" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`<div class=${layoutClasses}>
      ${repeat(
        this.slots,
        ({ key }) => key,
        ({ image }) => html`${renderMessageImageResource(image, opts)}`,
      )}
    </div>`;
  }
}

export const renderMessageImages = directive(MessageImagesDirective);

function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${buildManagedOutgoingImageVariantUrl(source, variant, opts?.resourceBasePath)}::${authToken}::${artifactId?.trim() ?? ""}`;
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
  const requesterSessionKey = resolveManagedOutgoingMediaSessionKey(source);
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
