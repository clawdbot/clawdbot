import { html, nothing } from "lit";
import "../../../components/image-lightbox.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import { openExternalUrlSafe } from "../../../lib/open-external-url.ts";

export function inlineChatImageFromEvent(event: Event): HTMLImageElement | null {
  const target = event
    .composedPath()
    .find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        (candidate.classList.contains("markdown-inline-image") ||
          candidate.classList.contains("markdown-inline-image-button")),
    );
  const image =
    target instanceof HTMLImageElement
      ? target
      : (target?.querySelector<HTMLImageElement>(".markdown-inline-image") ?? null);
  return image?.closest("a") ? null : image;
}

export function openInlineChatImage(
  event: Event,
  onOpenImage: ((item: ImageLightboxItem) => void) | undefined,
) {
  if (event.defaultPrevented) {
    return;
  }
  const image = inlineChatImageFromEvent(event);
  if (!image) {
    return;
  }
  event.preventDefault();
  const src = image.currentSrc || image.src;
  const title = image.alt.trim() || t("chat.imageLightbox.untitled");
  if (onOpenImage) {
    onOpenImage({ src, title });
  } else {
    openExternalUrlSafe(src, { allowDataImage: true });
  }
}

export function renderChatImageLightbox(
  item: ImageLightboxItem | null | undefined,
  onClose: (() => void) | undefined,
) {
  if (!item || !onClose) {
    return nothing;
  }
  return html`
    <openclaw-image-lightbox
      src=${item.src}
      title=${item.title}
      @image-lightbox-close=${onClose}
    ></openclaw-image-lightbox>
  `;
}
