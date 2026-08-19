import type {
  PreservedSessionWorktree,
  WorktreePreservationReason,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

const REASON_KEYS = {
  "owner-mismatch": "sessionsView.deletePreservedReasonOwnerMismatch",
  busy: "sessionsView.deletePreservedReasonBusy",
  "foreign-lock": "sessionsView.deletePreservedReasonForeignLock",
  "snapshot-failed": "sessionsView.deletePreservedReasonSnapshotFailed",
  "cleanup-failed": "sessionsView.deletePreservedReasonCleanupFailed",
} as const satisfies Record<WorktreePreservationReason, Parameters<typeof t>[0]>;

function describeWorktreePreservationReason(reason: WorktreePreservationReason): string {
  return t(REASON_KEYS[reason]);
}

export function formatPreservedWorktreesNotice(
  worktrees: readonly PreservedSessionWorktree[],
): string {
  return t("sessionsView.deletePreservedWorktrees", {
    count: String(worktrees.length),
    details: worktrees
      .map(
        (worktree) => `${worktree.branch} — ${describeWorktreePreservationReason(worktree.reason)}`,
      )
      .join("\n"),
  });
}

export function formatPreservedWorktreeConfirmation(worktree: PreservedSessionWorktree): string {
  return t("sessionsView.deletePreservedWorktreeConfirm", {
    branch: worktree.branch,
    reason: describeWorktreePreservationReason(worktree.reason),
  });
}
