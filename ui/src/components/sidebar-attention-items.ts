// Pure builder for the sidebar attention chips. Kept separate from the Lit
// element so the chip logic has a real cross-module consumer (the element) and
// can be unit-tested without rendering a component.
import type {
  CronJob,
  ModelAuthStatusResult,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import {
  formatUpdateTargetLabel,
  type ApplicationStatusBanner,
} from "../app/update-overlay-helpers.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { clampText, formatDurationHuman } from "../lib/format.ts";
import { isMonitoredAuthProvider, listEffectiveModelAuthProviders } from "../lib/model-auth.ts";
import type { CustodianAlert } from "./custodian-alert-contract.ts";
import type { IconName } from "./icons.ts";
import type { SidebarAttentionKind } from "./sidebar-attention-dismissals.ts";

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
// Per-job cap so a stack-trace-sized lastError cannot balloon the tooltip.
const CRON_ERROR_MAX_LENGTH = 200;
const ALERT_QUESTION_MAX_LENGTH = 1_000;

type SidebarAttentionAction =
  | { kind: "navigate"; routeId: NavigationRouteId }
  | { kind: "askCustodian"; alert: CustodianAlert }
  | { kind: "openApprovals" };

export type SidebarAttentionItem = {
  kind: SidebarAttentionKind;
  severity: "error" | "warning";
  icon: IconName;
  label: string;
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
  modelAuthAgentId?: string | null;
  approvalQueue: readonly ExecApprovalRequest[];
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  updateStatusBanner: ApplicationStatusBanner | null;
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
  const signatureOf = (ids: readonly string[]) => ids.toSorted().join("\n");
  const cronJobName = (job: CronJob) => job.name?.trim() || job.id;
  const boundedQuestion = (question: string) => clampText(question, ALERT_QUESTION_MAX_LENGTH);
  const explainedItem = (
    item: Omit<SidebarAttentionItem, "action">,
    alert: Omit<CustodianAlert, "id">,
  ): SidebarAttentionItem => ({
    ...item,
    action: {
      kind: "askCustodian",
      alert: { ...alert, id: `${item.kind}:${item.signature}` },
    },
  });

  const update = params.updateAvailable;
  const target = params.updateSchedule?.target;
  const commitsBehind = target?.kind === "git" ? target.commitsBehind : update?.commitsBehind;
  const updateAvailable = Boolean(
    update &&
    !params.updateSchedule?.campaign &&
    !params.updateStatusBanner &&
    (update.latestVersion !== update.currentVersion ||
      (target?.kind === "git" && target.commitsBehind > 0)),
  );
  if (update && updateAvailable) {
    const targetLabel = formatUpdateTargetLabel(params.updateSchedule, update);
    const signature = `${update.upstreamSha ?? (target?.kind === "git" ? target.upstreamSha : update.latestVersion)}\n${update.channel}`;
    const facts = update.commits?.length
      ? update.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`)
      : [
          t(
            commitsBehind !== undefined
              ? "updates.confirm.versionsBehind"
              : "updates.confirm.versions",
            {
              installed: t("updates.target.version", { version: update.currentVersion }),
              available:
                targetLabel ?? t("updates.target.version", { version: update.latestVersion }),
            },
          ),
        ];
    const question = boundedQuestion(
      t("attention.alerts.updateQuestion", { facts: facts.join("\n") }),
    );
    items.push(
      explainedItem(
        {
          kind: "updateAvailable",
          severity: "warning",
          icon: "download",
          label: targetLabel ?? update.latestVersion,
          signature,
        },
        {
          title: t("updates.page.available", { target: targetLabel ?? update.latestVersion }),
          facts,
          question,
          action: { label: t("updates.confirm.action"), target: { kind: "update" } },
        },
      ),
    );
  }

  if (params.approvalQueue.length > 0) {
    const count = params.approvalQueue.length;
    items.push({
      kind: "pendingApproval",
      severity: "warning",
      icon: "shieldQuestion",
      label: t(count === 1 ? "attention.pendingApproval" : "attention.pendingApprovals", {
        count: String(count),
      }),
      action: { kind: "openApprovals" },
      signature: signatureOf(params.approvalQueue.map((approval) => approval.id)),
    });
  }

  const failedCron = params.cronJobs.filter(isCronJobActiveFailure);
  if (failedCron.length > 0) {
    const facts = failedCron.map((job) => {
      const errorText = [job.state?.lastError, job.state?.lastErrorReason]
        .map((value) => value?.trim())
        .find((value): value is string => Boolean(value));
      return `${cronJobName(job)}: ${clampText(
        errorText ?? t("attention.cronErrorUnknown"),
        CRON_ERROR_MAX_LENGTH,
      )}`;
    });
    const signature = signatureOf(failedCron.map((job) => job.id));
    const label = t("attention.cronFailed", { count: String(failedCron.length) });
    items.push(
      explainedItem(
        { kind: "cronFailed", severity: "error", icon: "clock", label, signature },
        {
          title: label,
          facts,
          question: boundedQuestion(
            t("attention.alerts.cronFailedQuestion", { facts: facts.join("\n") }),
          ),
          action: { label: t("tabs.cron"), target: { kind: "navigate", routeId: "cron" } },
        },
      ),
    );
  }
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      !isCronJobRunning(job) &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  );
  if (overdueCron.length > 0) {
    const facts = overdueCron.map((job) =>
      t("attention.alerts.cronOverdueFact", {
        job: cronJobName(job),
        duration: formatDurationHuman(params.now - (job.state?.nextRunAtMs ?? params.now)),
      }),
    );
    // The planned run changes after recovery, so a later overdue episode resurfaces.
    const signature = signatureOf(overdueCron.map((job) => `${job.id}@${job.state?.nextRunAtMs}`));
    const label = t("attention.cronOverdue", { count: String(overdueCron.length) });
    items.push(
      explainedItem(
        { kind: "cronOverdue", severity: "warning", icon: "clock", label, signature },
        {
          title: label,
          facts,
          question: boundedQuestion(
            t("attention.alerts.cronOverdueQuestion", { facts: facts.join("\n") }),
          ),
          action: { label: t("tabs.cron"), target: { kind: "navigate", routeId: "cron" } },
        },
      ),
    );
  }

  const monitored = listEffectiveModelAuthProviders(params.modelAuthStatus?.providers ?? []).filter(
    isMonitoredAuthProvider,
  );
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  if (expired.length > 0) {
    const providerSignature = signatureOf(expired.map((provider) => provider.provider));
    // Auth is agent-scoped; one agent's dismissal must not hide another's warning.
    const signature = params.modelAuthAgentId
      ? `agent:${params.modelAuthAgentId}\n${providerSignature}`
      : providerSignature;
    const facts = expired.map((provider) => `${provider.displayName}: ${provider.status}`);
    const label = t("attention.modelAuthExpired", {
      providers: expired.map((provider) => provider.displayName).join(", "),
    });
    items.push(
      explainedItem(
        { kind: "modelAuthExpired", severity: "error", icon: "plug", label, signature },
        {
          title: label,
          facts,
          question: boundedQuestion(
            t("attention.alerts.modelAuthExpiredQuestion", { facts: facts.join("\n") }),
          ),
          action: {
            label: t("routeTitles.modelProviders"),
            target: { kind: "navigate", routeId: "model-providers" },
          },
        },
      ),
    );
  }
  return items;
}
