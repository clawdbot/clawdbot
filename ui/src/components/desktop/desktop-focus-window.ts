import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";

export function openDesktopFocus(basePath: string, source?: string | null, control = false): void {
  openExternalUrlSafe(buildControlUiFocusPath({ kind: "desktop", source, control }, basePath));
}
