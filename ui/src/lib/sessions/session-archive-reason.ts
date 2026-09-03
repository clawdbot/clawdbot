import type { SessionEntryArchiveReason } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

const ARCHIVE_REASON_LABELS = {
  manual: "sessionsView.archiveReasonManual",
  "active-session-cap": "sessionsView.archiveReasonActiveSessionCap",
  "stale-dashboard": "sessionsView.archiveReasonStaleDashboard",
  "restart-recovery": "sessionsView.archiveReasonRestartRecovery",
} as const satisfies Record<SessionEntryArchiveReason, string>;

export function formatSessionArchiveReason(reason: SessionEntryArchiveReason): string {
  return t(ARCHIVE_REASON_LABELS[reason]);
}
