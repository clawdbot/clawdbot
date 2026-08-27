import { html, nothing } from "lit";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { BrowserTarget } from "./discovery.ts";

export function renderPlaceBrowser(params: {
  listing: FsListDirResult | null;
  target: BrowserTarget;
  loading: boolean;
  error: string | null;
  pathDraft: string;
  usablePath: string | null;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onPathDraftChange: (value: string) => void;
  onNavigate: (path: string | undefined) => void;
  onBack: () => void;
  onRegisterProject: (path: string) => void;
  onClose: () => void;
  onApplyFolder: (path: string) => void;
}) {
  const entries = params.listing?.entries ?? [];
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
            if (params.listing?.parent) {
              params.onNavigate(params.listing.parent);
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
          aria-label=${t("newSession.folder")}
          placeholder=${params.target.label}
          .value=${params.pathDraft}
          @input=${(event: Event) => {
            params.onPathDraftChange((event.target as HTMLInputElement).value);
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              params.onNavigate(params.pathDraft.trim() || undefined);
            }
          }}
        />
        ${params.loading
          ? html`<span class="new-session-page__browser-loading">${t("common.loading")}</span>`
          : nothing}
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
      ${params.error ? html`<div class="new-session-page__error">${params.error}</div>` : nothing}
      <div class="new-session-page__browser-list" role="group" aria-label=${t("newSession.folder")}>
        ${params.listing && entries.length === 0 && !params.loading
          ? html`<div class="new-session-page__browser-empty">${t("newSession.browserEmpty")}</div>`
          : nothing}
        ${entries.map(
          (entry) => html`
            <button
              type="button"
              class="new-session-page__browser-entry ${entry.hidden
                ? "new-session-page__browser-entry--hidden"
                : ""}"
              title=${entry.hidden ? t("newSession.hiddenFolder") : nothing}
              @click=${() => params.onNavigate(entry.path)}
            >
              <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
              <span>${entry.name}</span>
            </button>
          `,
        )}
      </div>
      <div class="new-session-page__browser-actions">
        ${registerProjectPath
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
          : nothing}
        <button
          type="button"
          class="new-session-page__browser-use"
          ?disabled=${params.usablePath === null || params.registeringProject}
          @click=${() => {
            if (params.usablePath !== null) {
              params.onApplyFolder(params.usablePath);
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
