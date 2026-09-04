import { html } from "lit";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";

type CustomPluginUiDisabledContext = Pick<ApplicationContext<"labs">, "basePath" | "navigate"> & {
  readonly plugins: Pick<ApplicationContext["plugins"], "errors">;
};

export function renderCustomPluginUiDisabled(
  context: CustomPluginUiDisabledContext | undefined,
  pluginId: string,
  onNavigate?: () => void,
) {
  if (
    !context?.plugins?.errors.some(
      (diagnostic) =>
        diagnostic.pluginId === pluginId && diagnostic.code === "custom-plugin-ui-disabled",
    )
  ) {
    return undefined;
  }
  return html`<div class="card-title">${t("pluginUi.customPluginsDisabled")}</div>
    <p class="card-sub">${t("pluginUi.customPluginsEnableHint")}</p>
    <a
      class="btn btn--sm"
      href=${pathForRoute("labs", context.basePath)}
      @click=${(event: MouseEvent) => {
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          onNavigate?.();
          context.navigate("labs");
        }
      }}
      >${t("pluginUi.openLabs")}</a
    >`;
}
