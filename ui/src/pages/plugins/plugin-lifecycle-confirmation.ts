// Plugin code mutations restart the Gateway, so their UI entry points share one
// confirmation contract before either lifecycle request can be dispatched.
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";

export function confirmPluginInstall(request: PluginInstallRequest): Promise<boolean> {
  const name = request.source === "official" ? request.pluginId : request.packageName;
  return showConfirmDialog({
    title: t("pluginsPage.installConfirmTitle", { name }),
    message: t("pluginsPage.installConfirmMessage"),
    confirmLabel: t("pluginsPage.install"),
  });
}

export function confirmPluginUninstall(name: string): Promise<boolean> {
  return showConfirmDialog({
    title: t("pluginsPage.removeConfirmTitle", { name }),
    message: t("pluginsPage.removeConfirmMessage"),
    confirmLabel: t("pluginsPage.remove"),
    danger: true,
  });
}
