import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { isMonitoredAuthProvider } from "../lib/model-auth.ts";
import type { IconName } from "./icons.ts";

const CRON_OVERDUE_GRACE_MS = 300_000;

type SidebarIssueSeverity = "blocking" | "warning";

export type SidebarIssueAction =
  | { kind: "navigate"; routeId: NavigationRouteId }
  | { kind: "openApprovals" };

export type SidebarIssueCondition = {
  id: string;
  sourceKind: "approval" | "automation" | "provider";
  severity: SidebarIssueSeverity;
  icon: IconName;
  entityLabel: string;
  stateLabel: string;
  action: SidebarIssueAction;
  raisedAt: number;
};

export type SidebarAutomationAttention = {
  count: number;
  severity: "danger" | "warning" | null;
};

type SidebarIssuesSnapshot = {
  conditions: SidebarIssueCondition[];
  automationAttention: SidebarAutomationAttention;
};

function cronJobName(job: CronJob): string {
  return job.name?.trim() || job.id;
}

export function buildSidebarIssuesSnapshot(params: {
  cronJobs: readonly CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  approvalQueue: readonly ExecApprovalRequest[];
  now: number;
}): SidebarIssuesSnapshot {
  const conditions: SidebarIssueCondition[] = [];
  const failedCron = params.cronJobs.filter(isCronJobActiveFailure);
  // The scheduler records this only after the effective per-job/global alert
  // threshold passes, so the browser never has to duplicate that policy.
  const repeatedlyFailingCron = failedCron.filter(
    (job) => typeof job.state?.lastFailureAlertAtMs === "number",
  );
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      !isCronJobRunning(job) &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  );

  for (const job of repeatedlyFailingCron) {
    conditions.push({
      id: `automation.failing-repeatedly.${job.id}`,
      sourceKind: "automation",
      severity: "warning",
      icon: "calendarClock",
      entityLabel: cronJobName(job),
      stateLabel: t("attention.failingRepeatedly"),
      action: { kind: "navigate", routeId: "cron" },
      raisedAt: job.state?.lastFailureAlertAtMs ?? params.now,
    });
  }

  for (const job of overdueCron) {
    conditions.push({
      id: `automation.overdue.${job.id}`,
      sourceKind: "automation",
      severity: "warning",
      icon: "calendarClock",
      entityLabel: cronJobName(job),
      stateLabel: t("attention.overdue"),
      action: { kind: "navigate", routeId: "cron" },
      raisedAt: Math.min(job.state?.nextRunAtMs ?? params.now, params.now),
    });
  }

  for (const provider of (params.modelAuthStatus?.providers ?? [])
    .filter(isMonitoredAuthProvider)
    .filter((candidate) => candidate.status === "expired" || candidate.status === "missing")) {
    conditions.push({
      id: `auth.expired.${provider.provider}`,
      sourceKind: "provider",
      severity: "blocking",
      icon: "plug",
      entityLabel: provider.displayName,
      stateLabel: t("attention.authExpired"),
      action: { kind: "navigate", routeId: "model-setup" },
      raisedAt: params.now,
    });
  }

  if (params.approvalQueue.length > 0) {
    const count = params.approvalQueue.length;
    conditions.push({
      id: "approval.pending",
      sourceKind: "approval",
      severity: "warning",
      icon: "shieldCheck",
      entityLabel: t("attention.approvals"),
      stateLabel: t(
        count === 1 ? "attention.pendingApprovalState" : "attention.pendingApprovalsState",
        { count: String(count) },
      ),
      action: { kind: "openApprovals" },
      raisedAt: Math.max(...params.approvalQueue.map((approval) => approval.createdAtMs)),
    });
  }

  conditions.sort((first, second) => {
    const severity =
      first.severity === second.severity ? 0 : first.severity === "blocking" ? -1 : 1;
    return severity || second.raisedAt - first.raisedAt;
  });

  const automationIds = new Set([...failedCron, ...overdueCron].map((job) => job.id));
  return {
    conditions,
    automationAttention: {
      count: automationIds.size,
      severity: failedCron.length > 0 ? "danger" : overdueCron.length > 0 ? "warning" : null,
    },
  };
}
