import type { WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

export function desktopAppLabel(app: WorkerDesktopAppId): string {
  return app === "browser" ? t("desktop.browser") : t("desktop.terminal");
}

export function desktopAppIcon(app: WorkerDesktopAppId) {
  return app === "browser" ? icons.chrome : icons.terminal;
}
