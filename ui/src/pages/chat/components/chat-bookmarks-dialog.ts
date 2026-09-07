import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatBookmark, ChatBookmarks } from "../chat-bookmarks.ts";
import "./chat-bookmarks.css";

export function renderChatBookmarksDialog(
  state: ChatBookmarks,
  actions: { update: () => void; open: (bookmark: ChatBookmark) => void },
) {
  const scope = state.scope;
  if (!state.open || !scope) {
    return nothing;
  }
  const current = () => state.scope === scope && scope.isCurrent();
  const guardOwner = {
    capture: true,
    handleEvent(event: Event) {
      if (!current()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
  };
  const close = () => {
    if (current()) {
      state.open = false;
      state.editor = null;
      actions.update();
    }
  };
  const editor = state.editor;
  const nameLength = Array.from(editor?.name.trim() ?? "").length;
  const title = t(
    editor
      ? editor.bookmark
        ? "chat.bookmarks.rename"
        : "chat.bookmarks.add"
      : "chat.bookmarks.title",
  );
  return html`
    <openclaw-modal-dialog label=${title} @modal-cancel=${close}>
      <section
        class="exec-approval-card chat-bookmarks-dialog"
        @click=${guardOwner}
        @input=${guardOwner}
        @submit=${guardOwner}
      >
        <h2>${title}</h2>
        ${state.error ? html`<p role="alert">${state.error}</p>` : nothing}
        ${
          editor
            ? html` <form
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  void state.save();
                }}
              >
                <label class="field">
                  <span>${t("chat.bookmarks.name")}</span>
                  <input
                    autofocus
                    .value=${editor.name}
                    ?disabled=${state.saving}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        editor.name = event.currentTarget.value;
                        actions.update();
                      }
                    }}
                  />
                </label>
                <p class="muted" aria-live="polite">
                  ${t("chat.bookmarks.nameLimit", { count: String(nameLength) })}
                </p>
                <div class="exec-approval-actions">
                  <button class="btn" type="button" @click=${close}>${t("common.cancel")}</button>
                  <button
                    class="btn primary"
                    type="submit"
                    ?disabled=${state.saving || nameLength < 1 || nameLength > 70}
                  >
                    ${t("common.save")}
                  </button>
                </div>
              </form>`
            : html` <p class="muted">${t("chat.bookmarks.personal")}</p>
                <label class="field">
                  <span>${t("chat.bookmarks.search")}</span>
                  <input
                    type="search"
                    autofocus
                    .value=${state.query}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        state.query = event.currentTarget.value;
                        actions.update();
                      }
                    }}
                  />
                </label>
                <label class="field checkbox">
                  <input
                    type="checkbox"
                    .checked=${state.allConversations}
                    @change=${(event: Event) => {
                      if (current() && event.currentTarget instanceof HTMLInputElement) {
                        state.allConversations = event.currentTarget.checked;
                        actions.update();
                      }
                    }}
                  />
                  <span>${t("chat.bookmarks.allConversations")}</span>
                </label>
                <ul class="chat-bookmarks-dialog__list" aria-busy=${state.loading}>
                  ${repeat(
                    state.results,
                    (item) => item.id,
                    (item) => html` <li class="chat-bookmarks-dialog__item">
                      <button
                        class="btn btn--ghost chat-bookmarks-dialog__source"
                        type="button"
                        ?disabled=${!state.canOpen(item)}
                        title=${!state.canOpen(item) ? t("chat.bookmarks.unavailable") : nothing}
                        @click=${() => actions.open(item)}
                      >
                        ${item.name}
                        ${state.allConversations ? html`<br /><small class="muted">${item.sessionKey}</small>` : nothing}
                      </button>
                      ${
                        scope.canWrite
                          ? html`
                              <button
                                class="btn btn--ghost"
                                type="button"
                                ?disabled=${state.saving}
                                @click=${() => state.edit(item.messageId, item)}
                              >
                                ${t("common.rename")}
                              </button>
                              <button
                                class="btn btn--ghost"
                                type="button"
                                ?disabled=${state.saving}
                                @click=${() => {
                                  void state.remove(item);
                                }}
                              >
                                ${t("common.remove")}
                              </button>
                            `
                          : nothing
                      }
                    </li>`,
                  )}
                </ul>
                ${
                  state.loading
                    ? html`<p role="status">${t("common.loading")}</p>`
                    : state.results.length === 0
                      ? html`<p>${t("chat.bookmarks.empty")}</p>`
                      : nothing
                }
                <footer class="exec-approval-actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.loading}
                    @click=${() => {
                      void state.refreshIndex();
                    }}
                  >
                    ${t("chat.bookmarks.reload")}
                  </button>
                  <button class="btn primary" type="button" @click=${close}>
                    ${t("common.close")}
                  </button>
                </footer>`
        }
      </section>
    </openclaw-modal-dialog>
  `;
}
