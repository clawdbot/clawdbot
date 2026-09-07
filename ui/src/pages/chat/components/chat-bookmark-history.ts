import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerBookmarksEnglish } from "../../../i18n/locales/en-bookmarks.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import type { ChatBookmarkHistory } from "../chat-bookmarks.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { renderAssistantAttachments, renderOmittedMedia } from "./chat-message-attachments.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { projectMessageMedia, type ImageRenderOptions } from "./chat-message-media.ts";
import { renderMessageMarkdown, resolveMessageDisplayMarkdown } from "./chat-message-text.ts";

registerBookmarksEnglish();

function renderHistoryMessage(
  message: unknown,
  index: number,
  history: ChatBookmarkHistory,
  media: ImageRenderOptions,
) {
  const id = persistedMessageEntryId(message);
  const selected = id === history.bookmark.messageId;
  const normalized = normalizeMessage(message);
  const role = normalizeRoleForGrouping(normalized.role);
  const markdown = resolveMessageDisplayMarkdown(message, normalized);
  const { images, attachments } = projectMessageMedia(message, normalized.content);
  const omitted = normalized.content.filter((item) => item.type === "omitted_media");
  const options: ImageRenderOptions = {
    ...media,
    canonicalMessageKey: JSON.stringify([history.bookmark.sessionId, id ?? index]),
    onRequestUpdate: history.updateMedia,
    allowPermissionRequests: false,
  };
  // Passive content only: live bubbles also mount tools, approvals and Canvas.
  return html`<article
    class="chat-bookmarks-dialog__history-message ${selected ? "chat-bookmarks-dialog__history-message--target" : ""}"
    data-bookmark-message-id=${id ?? nothing}
  >
    <header class="chat-bookmarks-dialog__message-label">
      <span>${t(role === "user" ? "chat.bookmarks.user" : "chat.bookmarks.assistant")}</span
      >${selected ? html`<span>${t("chat.bookmarks.markedMessage")}</span>` : nothing}
    </header>
    ${renderMessageImages(images, options)}
    ${renderAssistantAttachments(attachments, options, undefined, undefined, false)}
    ${renderOmittedMedia(omitted)}
    ${markdown ? renderMessageMarkdown(markdown, id ?? String(index), { role, isStreaming: false }, { codeBlockChrome: "none", codeBlockInteraction: "static", fileLinks: false, sessionLinks: false, remoteImages: false }) : images.length || attachments.length || omitted.length ? nothing : html`<p class="muted">${t("chat.bookmarks.noPreview")}</p>`}
  </article>`;
}

export function renderBookmarkHistory(
  history: ChatBookmarkHistory,
  actions: { close: () => void; back: () => void; update: () => void; retry: () => void },
  media: ImageRenderOptions = {},
) {
  const result = history.result;
  return html`
    <header class="chat-bookmarks-dialog__history-header">
      <div class="chat-bookmarks-dialog__history-toolbar">
        <button
          class="btn btn--ghost"
          type="button"
          aria-label=${t("chat.bookmarks.back")}
          @click=${actions.back}
        >
          ${icons.chevronLeft}<span>${t("chat.bookmarks.title")}</span>
        </button>
        <button
          class="btn btn--ghost"
          type="button"
          aria-label=${t("chat.bookmarks.closePreview")}
          @click=${actions.close}
        >
          ${icons.x}
        </button>
      </div>
      <div class="chat-bookmarks-dialog__history-title">
        <h2>${history.bookmark.name}</h2>
        <span class="chat-bookmarks-dialog__readonly">${t("chat.bookmarks.readOnly")}</span>
      </div>
      <p class="muted">${t("chat.bookmarks.earlier")}</p>
    </header>
    <p class="chat-bookmarks-dialog__history-notice">${t("chat.bookmarks.historyNotice")}</p>
    <div class="chat-bookmarks-dialog__history-body" aria-busy=${result.status === "loading"}>
      ${result.status === "loading" ? html`<p role="status">${t("common.loading")}</p>` : result.status === "error" ? html`<p role="alert">${result.message}</p>` : result.messages.map((message, index) => (history.showContext || persistedMessageEntryId(message) === history.bookmark.messageId ? renderHistoryMessage(message, index, history, media) : nothing))}
    </div>
    <footer class="chat-bookmarks-dialog__history-actions">
      ${
        result.status === "loaded" && result.messages.length > 1
          ? html`<button
              class="btn btn--ghost"
              type="button"
              aria-expanded=${String(history.showContext)}
              @click=${() => {
                history.showContext = !history.showContext;
                actions.update();
              }}
            >
              ${t(history.showContext ? "chat.bookmarks.hideContext" : "chat.bookmarks.showContext")}
            </button>`
          : result.status === "error"
            ? html`<button class="btn" type="button" @click=${actions.retry}>
                ${t("common.retry")}
              </button>`
            : nothing
      }
      <button class="btn" type="button" @click=${actions.close}>${t("common.close")}</button>
    </footer>
  `;
}
