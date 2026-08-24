import { html, nothing } from "lit";
import "../../../components/image-lightbox.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";

export function isImageLightboxEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) => target instanceof HTMLElement && target.localName === "openclaw-image-lightbox",
    );
}

function inlineChatImageFromEvent(event: Event): HTMLImageElement | null {
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
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  const image = inlineChatImageFromEvent(event);
  if (!image) {
    return false;
  }
  event.preventDefault();
  const src = image.currentSrc || image.src;
  const title = image.alt.trim() || t("chat.imageLightbox.untitled");
  openResolvedImage(onOpenImage, src, title);
  return true;
}

export function renderChatImageLightbox(
  item: ImageLightboxItem | null | undefined,
  onClose: () => void,
) {
  if (!item) {
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
