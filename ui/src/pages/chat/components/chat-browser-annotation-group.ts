import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { getChatAttachmentPreviewUrl } from "../attachment-payload-store.ts";

export function renderBrowserAnnotationGroup(params: {
  attachments: readonly ChatAttachment[];
  disabled?: boolean;
  onRemove: () => void;
}) {
  const { attachments, disabled, onRemove } = params;
  const labelKey =
    attachments.length === 1
      ? "chat.composer.browserAnnotationCount"
      : "chat.composer.browserAnnotationCountPlural";
  const label = t(labelKey, { count: String(attachments.length) });
  return html`<div class="chat-browser-annotation-group" role="group" aria-label=${label}>
    <div
      class="chat-browser-annotation-group__summary"
      data-attachment-id=${attachments[0]?.id ?? ""}
      tabindex="0"
    >
      <span aria-hidden="true">${icons.messageSquare}</span>
      <span>${label}</span>
      <button
        type="button"
        class="chat-browser-annotation-group__remove"
        aria-label=${t("chat.composer.removeBrowserAnnotation", { name: label })}
        ?disabled=${disabled}
        @click=${onRemove}
      >
        ${icons.x}
      </button>
    </div>
    <div
      class="chat-browser-annotation-group__popover"
      aria-label=${t("chat.composer.browserAnnotation")}
    >
      ${attachments.map((attachment, index) => {
        const annotation = attachment.browserAnnotation!;
        const preview = getChatAttachmentPreviewUrl(attachment);
        const selector = annotation.selector || annotation.title || annotation.displayUrl;
        return html`<article class="chat-browser-annotation-group__item">
          ${
            preview
              ? html`<img src=${preview} alt=${t("chat.composer.browserAnnotationPreview")} />`
              : nothing
          }
          <div class="chat-browser-annotation-group__item-copy">
            <div class="chat-browser-annotation-group__item-title">
              <span class="chat-browser-annotation-group__number">${index + 1}</span>
              ${annotation.elementTag ? html`<code>${annotation.elementTag}</code>` : nothing}
              <span title=${selector}>${selector}</span>
            </div>
            <p>${annotation.comment || annotation.title}</p>
          </div>
        </article>`;
      })}
    </div>
  </div>`;
}
