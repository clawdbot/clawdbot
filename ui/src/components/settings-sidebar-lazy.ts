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
    <div class="settings-sidebar__empty" role=${failed ? "alert" : "status"}>
      ${failed ? t("nav.settingsLoadFailed") : t("common.loading")}
      ${failed
        ? html`<button
            class="btn btn--sm"
            type="button"
            @click=${() => host.retrySettingsSidebarRenderer()}
          >
            ${t("common.retry")}
          </button>`
        : nothing}
    </div>
  </aside>`;
}
