import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { PlaceBrowserState } from "./place-browser-state.ts";

export function renderPlaceBrowser(params: {
  browser: PlaceBrowserState;
  id: string;
  label: string;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onBack: () => void;
  onRegisterProject: (path: string) => void;
  onClose: () => void;
  onApplyFolder: (path: string) => void;
}) {
  const { browser, id } = params;
  const { entries, empty } = browser.view();
  const highlighted = browser.highlightedEntry();
  const usablePath = browser.usablePath();
  const registerProjectPath = params.registerProjectPath;
  return html`
    <div
      class="new-session-page__browser"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        params.onBack();
      }}
    >
      <div class="new-session-page__browser-head">
        <button
          type="button"
          class="new-session-page__browser-nav"
          title=${t("newSession.browserUp")}
          aria-label=${t("newSession.browserUp")}
          @click=${() => {
            if (browser.listing?.parent) {
              void browser.navigate(browser.listing.parent);
            } else {
              params.onBack();
            }
          }}
        >
          ${icons.arrowLeft}
        </button>
        <input
          class="new-session-page__browser-path"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls=${`${id}-list`}
          aria-activedescendant=${highlighted ? `${id}-option-${browser.activeIndex}` : nothing}
          aria-label=${t("newSession.folder")}
          placeholder=${params.label}
          .value=${browser.draft}
          @input=${(event: Event) => {
            browser.setDraft((event.target as HTMLInputElement).value);
          }}
          @keydown=${(event: KeyboardEvent) => {
            switch (event.key) {
              case "ArrowDown":
              case "ArrowUp":
                event.preventDefault();
                browser.moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                requestAnimationFrame(() =>
                  document
                    .getElementById(`${id}-option-${browser.activeIndex}`)
                    ?.scrollIntoView({ block: "nearest" }),
                );
                break;
              case "Enter":
                event.preventDefault();
                void browser.activate();
                break;
              case "Tab":
                if (!event.shiftKey && browser.completeHighlighted()) {
                  event.preventDefault();
                }
                break;
            }
          }}
        />
        ${
          browser.loading
            ? html`<span class="new-session-page__browser-loading">${t("common.loading")}</span>`
            : nothing
        }
        <button
          type="button"
          class="new-session-page__browser-nav"
          title=${t("common.close")}
          aria-label=${t("common.close")}
          @click=${params.onClose}
        >
          ${icons.x}
        </button>
      </div>
      ${browser.error ? html`<div class="new-session-page__error">${browser.error}</div>` : nothing}
      <div
        class="new-session-page__browser-list"
        role="listbox"
        id=${`${id}-list`}
        aria-label=${t("newSession.folder")}
      >
        ${
          empty !== "none"
            ? html`<div class="new-session-page__browser-empty">
                ${t(empty === "no-matches" ? "newSession.browserNoMatches" : "newSession.browserEmpty")}
              </div>`
            : nothing
        }
        ${entries.map(
          (entry, index) => html`
            <button
              type="button"
              role="option"
              id=${`${id}-option-${index}`}
              aria-selected=${index === browser.activeIndex}
              class="new-session-page__browser-entry ${
                index === browser.activeIndex ? "new-session-page__browser-entry--active" : ""
              } ${entry.hidden ? "new-session-page__browser-entry--hidden" : ""}"
              title=${entry.hidden ? t("newSession.hiddenFolder") : nothing}
              @click=${() => void browser.navigate(entry.path)}
            >
              <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
              <span>${entry.name}</span>
            </button>
          `,
        )}
      </div>
      <div class="new-session-page__browser-actions">
        ${
          registerProjectPath
            ? html`
                <button
                  type="button"
                  class="new-session-page__browser-register"
                  ?disabled=${params.registeringProject}
                  @click=${() => params.onRegisterProject(registerProjectPath)}
                >
                  ${t("newSession.registerProject")}
                </button>
              `
            : nothing
        }
        <button
          type="button"
          class="new-session-page__browser-use"
          ?disabled=${usablePath === null || params.registeringProject}
          @click=${() => {
            if (usablePath !== null) {
              params.onApplyFolder(usablePath);
              params.onClose();
            }
          }}
        >
          ${t("newSession.browserUse")}
        </button>
      </div>
    </div>
  `;
}
