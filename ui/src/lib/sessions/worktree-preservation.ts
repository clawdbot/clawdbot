import type { PreservedSessionWorktree } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

export function formatPreservedWorktreesNotice(
  worktrees: readonly PreservedSessionWorktree[],
): string {
  const details = worktrees
    .map(
      (worktree) =>
        `${worktree.branch} — ${t(`sessionsView.deletePreservedReasons.${worktree.reason}`)}`,
    )
    .join("\n");
  return `${t("worktrees.title")}:\n${details}`;
}

export function formatPreservedWorktreeConfirmation(worktree: PreservedSessionWorktree): string {
  const reason = t(`sessionsView.deletePreservedReasons.${worktree.reason}`);
  return `${t("sessionsView.attentionRequired")}: ${worktree.branch} — ${reason}. ${t("common.remove")}?`;
}
