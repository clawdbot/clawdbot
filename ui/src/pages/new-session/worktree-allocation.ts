import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { DraftBranches } from "./discovery.ts";

registerNewSessionSetupEnglish();

export function worktreeAllocationBlockedReason(
  status: DraftBranches["allocationStatus"],
): string | undefined {
  if (status === "insufficient-space") {
    return t("newSession.capacityFull");
  }
  return status === "unavailable" ? t("newSession.capacityUnknown") : undefined;
}
