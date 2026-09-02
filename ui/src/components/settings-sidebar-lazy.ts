import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type SettingsSidebarModule = typeof import("./settings-sidebar.ts");
type SettingsSidebarProps = Parameters<SettingsSidebarModule["renderSettingsSidebar"]>[0];

type LazySettingsSidebarHost = {
  readonly settingsSidebarRenderer: SettingsSidebarModule["renderSettingsSidebar"] | null;
  readonly settingsSidebarLoadFailed: boolean;
  loadSettingsSidebarRenderer(): void;
  retrySettingsSidebarRenderer(): void;
};

export function renderLazySettingsSidebar(
  host: LazySettingsSidebarHost,
  props: SettingsSidebarProps,
) {
  const renderer = host.settingsSidebarRenderer;
  if (renderer) {
    return renderer(props);
  }
  const failed = host.settingsSidebarLoadFailed;
  if (!failed) {
    host.loadSettingsSidebarRenderer();
  }
  return html`<aside class="settings-sidebar" aria-busy=${failed ? nothing : "true"}>
    <header class="settings-sidebar__header">
      <button type="button" class="settings-sidebar__back" @click=${props.onExit}>
        <span class="settings-sidebar__back-icon" aria-hidden="true">${icons.arrowLeft}</span>
        ${t("nav.exitSettings")}
      </button>
      <h1 class="settings-sidebar__title">${t("nav.settings")}</h1>
    </header>
    ${failed
      ? html`<div class="settings-sidebar__empty" role="alert">
          ${t("nav.settingsLoadFailed")}
          <button
            class="btn btn--sm"
            type="button"
            @click=${() => host.retrySettingsSidebarRenderer()}
          >
            ${t("common.retry")}
          </button>
        </div>`
      : html`<div
          class="settings-loading-skeleton settings-sidebar__loading"
          role="status"
          aria-busy="true"
          aria-label=${t("common.loading")}
        >
          <div class="settings-sidebar__loading-rows" aria-hidden="true">
            ${Array.from(
              { length: 7 },
              () => html`<span class="skeleton settings-sidebar__loading-row"></span>`,
            )}
          </div>
        </div>`}
  </aside>`;
}
