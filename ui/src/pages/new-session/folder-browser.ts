import { html, nothing } from "lit";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { BrowserTarget, DraftNode } from "./discovery.ts";

export function renderFolderBrowser(params: {
  open: boolean;
  listing: FsListDirResult | null;
  target: BrowserTarget | null;
  nodes: DraftNode[];
  loading: boolean;
  error: string | null;
  pathDraft: string;
  usablePath: string | null;
  onPathDraftChange: (value: string) => void;
  onNavigate: (path: string | undefined) => void;
  onShowRoot: () => void;
  onClose: () => void;
  onSelectTarget: (target: BrowserTarget) => void;
  nodeBlockedReason: (node: DraftNode) => string | undefined;
  onApplyFolder: (path: string, nodeId: string) => void;
}) {
  if (!params.open) {
    return nothing;
  }
  const entries = params.listing?.entries ?? [];
  return html`
    <div class="new-session-page__browser">
      <div class="new-session-page__browser-head">
        <button
          type="button"
          class="new-session-page__browser-nav"
          title=${t("newSession.browserUp")}
          aria-label=${t("newSession.browserUp")}
          ?disabled=${!params.target || (!params.listing && params.loading)}
          @click=${() => {
            if (params.listing?.parent) {
              params.onNavigate(params.listing.parent);
            } else if (params.target) {
              params.onShowRoot();
            }
          }}
        >
          ${icons.arrowLeft}
        </button>
        ${params.target
          ? html`
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
            `
          : html`<span class="new-session-page__browser-path">${t("newSession.where")}</span>`}
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
        ${!params.target
          ? html`
              <button
                type="button"
                class="new-session-page__browser-entry"
                @click=${() =>
                  params.onSelectTarget({ nodeId: "", label: t("newSession.gateway") })}
              >
                <span class="new-session-page__target-icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <span>${t("newSession.gateway")}</span>
              </button>
              ${params.nodes.map(
                (node) => html`
                  <button
                    type="button"
                    class="new-session-page__browser-entry"
                    ?disabled=${!node.canExec}
                    title=${params.nodeBlockedReason(node) ?? nothing}
                    @click=${() =>
                      params.onSelectTarget({ nodeId: node.nodeId, label: node.displayName })}
                  >
                    <span class="new-session-page__target-icon" aria-hidden="true"
                      >${icons.monitor}</span
                    >
                    <span>${node.displayName}</span>
                  </button>
                `,
              )}
            `
          : nothing}
        ${params.listing && entries.length === 0 && !params.loading
          ? html`<div class="new-session-page__browser-empty">${t("newSession.browserEmpty")}</div>`
          : nothing}
        ${params.target
          ? entries.map(
              (entry) => html`
                <button
                  type="button"
                  class="new-session-page__browser-entry ${entry.hidden
                    ? "new-session-page__browser-entry--hidden"
                    : ""}"
                  title=${entry.hidden ? t("newSession.hiddenFolder") : nothing}
                  @click=${() => params.onNavigate(entry.path)}
                >
                  <span class="new-session-page__target-icon" aria-hidden="true"
                    >${icons.folder}</span
                  >
                  <span>${entry.name}</span>
                </button>
              `,
            )
          : nothing}
      </div>
      <div class="new-session-page__browser-actions">
        <button
          type="button"
          class="new-session-page__browser-use"
          ?disabled=${!params.target || params.usablePath === null}
          @click=${() => {
            if (params.target && params.usablePath !== null) {
              params.onApplyFolder(params.usablePath, params.target.nodeId);
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
