// Pure builder for the sidebar attention chips. Kept separate from the Lit
// element so the chip logic has a real cross-module consumer (the element) and
// can be unit-tested without rendering a component.
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure } from "../lib/cron-status.ts";
import { clampText } from "../lib/format.ts";
import { isMonitoredAuthProvider } from "../lib/model-auth.ts";
import type { IconName } from "./icons.ts";
import type { SidebarAttentionKind } from "./sidebar-attention-dismissals.ts";

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
// Per-job cap so a stack-trace-sized lastError cannot balloon the tooltip.
const CRON_ERROR_MAX_LENGTH = 200;

type SidebarAttentionAction =
  | { kind: "navigate"; routeId: NavigationRouteId }
  | { kind: "openApprovals" };

export type SidebarAttentionItem = {
  kind: SidebarAttentionKind;
  severity: "error" | "warning";
  icon: IconName;
  label: string;
  // Multi-line tooltip body; "\n" separates lines rendered via pre-line.
  detail?: string;
  action: SidebarAttentionAction;
  // Sorted identities of the entities behind the chip. A dismissal stores
  // this signature so the chip stays hidden only while the same incident set
  // is affected; any change (new job/provider, new overdue run) resurfaces
  // it. Failed-cron and auth chips key on entity ids alone on purpose: a
  // persistently failing job gets a new lastRunAtMs every schedule tick, and
  // short-lived OAuth tokens (e.g. Copilot) roll expiry continuously — either
  // in the signature would resurface a dismissed chip within minutes. The
  // cost is that a recover-then-recur cycle nobody observed stays snoozed;
  // pruneAfterRefresh re-arms as soon as any tab sees the cleared state.
  signature: string;
};

export function buildSidebarAttentionItems(params: {
  cronJobs: readonly CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  approvalQueue: readonly ExecApprovalRequest[];
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
  const signatureOf = (ids: readonly string[]) => ids.toSorted().join("\n");
  const cronJobName = (job: CronJob) => job.name?.trim() || job.id;

  if (params.approvalQueue.length > 0) {
    const count = params.approvalQueue.length;
    items.push({
      kind: "pendingApproval",
      severity: "warning",
      icon: "shieldCheck",
      label: t(count === 1 ? "attention.pendingApproval" : "attention.pendingApprovals", {
        count: String(count),
      }),
      action: { kind: "openApprovals" },
      signature: signatureOf(params.approvalQueue.map((approval) => approval.id)),
    });
  }

  const failedCron = params.cronJobs.filter(isCronJobActiveFailure);
  if (failedCron.length > 0) {
    items.push({
      kind: "cronFailed",
      severity: "error",
      icon: "clock",
      label: t("attention.cronFailed", { count: String(failedCron.length) }),
      detail: failedCron
        .map((job) => {
          const errorText = [job.state?.lastError, job.state?.lastErrorReason]
            .map((value) => value?.trim())
            .find((value): value is string => Boolean(value));
          const resolvedError = errorText ?? t("attention.cronErrorUnknown");
          return `${cronJobName(job)}: ${clampText(resolvedError, CRON_ERROR_MAX_LENGTH)}`;
        })
        .join("\n"),
      action: { kind: "navigate", routeId: "cron" },
      signature: signatureOf(failedCron.map((job) => job.id)),
    });
  }
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  );
  if (overdueCron.length > 0) {
    items.push({
      kind: "cronOverdue",
      severity: "warning",
      icon: "clock",
      label: t("attention.cronOverdue", { count: String(overdueCron.length) }),
      detail: overdueCron.map(cronJobName).join("\n"),
      action: { kind: "navigate", routeId: "cron" },
      // nextRunAtMs is the incident identity: stable while a job stays stuck,
      // new once it runs again and later goes overdue anew — so a fresh
      // overdue episode resurfaces even if no tab observed the recovery.
      signature: signatureOf(overdueCron.map((job) => `${job.id}@${job.state?.nextRunAtMs}`)),
    });
  }

  const monitored = (params.modelAuthStatus?.providers ?? []).filter(isMonitoredAuthProvider);
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  if (expired.length > 0) {
    items.push({
      kind: "modelAuthExpired",
      severity: "error",
      icon: "plug",
      label: t("attention.modelAuthExpired", {
        providers: expired.map((provider) => provider.displayName).join(", "),
      }),
      action: { kind: "navigate", routeId: "model-providers" },
      signature: signatureOf(expired.map((provider) => provider.provider)),
    });
  }
  return items;
}
