import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";

export function desktopFocusPath(
  basePath: string,
  source?: string | null,
  control = false,
): string {
  return buildControlUiFocusPath({ kind: "desktop", source, control }, basePath);
}

export function openDesktopFocus(basePath: string, source?: string | null, control = false): void {
  openExternalUrlSafe(desktopFocusPath(basePath, source, control));
}
