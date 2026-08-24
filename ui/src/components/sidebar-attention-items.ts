import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { clampText, formatTimeAgo } from "../lib/format.ts";
import { isMonitoredAuthProvider, listEffectiveModelAuthProviders } from "../lib/model-auth.ts";
import type { CustodianAlert } from "./custodian-alert-contract.ts";
import type { IconName } from "./icons.ts";
import type { SidebarAttentionKind } from "./sidebar-attention-dismissals.ts";

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
const ALERT_QUESTION_MAX_LENGTH = 1_000;

type SidebarAttentionAction =
  | { kind: "navigate"; routeId: NavigationRouteId }
  | { kind: "askCustodian"; alert: CustodianAlert };

export type SidebarAttentionItem = {
  kind: SidebarAttentionKind;
  severity: "error" | "warning";
  icon: IconName;
  label: string;
  detail: string;
  meta?: { context?: string; status: string; time: string };
  action: SidebarAttentionAction;
  inlineAction?: { label: string; routeId: NavigationRouteId };
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
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
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

  const failedCron = params.cronJobs
    .filter(isCronJobActiveFailure)
    .toSorted(
      (left, right) =>
        (right.state?.lastRunAtMs ?? right.updatedAtMs) -
        (left.state?.lastRunAtMs ?? left.updatedAtMs),
    );
  for (const job of failedCron) {
    const jobName = cronJobName(job);
    const time = formatTimeAgo(
      Math.max(0, params.now - (job.state?.lastRunAtMs ?? job.updatedAtMs)),
    );
    items.push({
      kind: "cronFailed",
      severity: "error",
      icon: "clock",
      label: jobName,
      detail: t("attention.automationFailed", { time }),
      meta: { status: t("attention.failed"), time },
      action: { kind: "navigate", routeId: "cron" },
      signature: job.id,
    });
  }
  const overdueCron = params.cronJobs
    .filter(
      (job) =>
        job.enabled &&
        !isCronJobRunning(job) &&
        job.state?.nextRunAtMs != null &&
        params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
    )
    .toSorted(
      (left, right) =>
        (right.state?.nextRunAtMs ?? right.updatedAtMs) -
        (left.state?.nextRunAtMs ?? left.updatedAtMs),
    );
  for (const job of overdueCron) {
    const jobName = cronJobName(job);
    // The planned run changes after recovery, so a later overdue episode resurfaces.
    const signature = `${job.id}@${job.state?.nextRunAtMs}`;
    const time = formatTimeAgo(
      Math.max(0, params.now - (job.state?.nextRunAtMs ?? job.updatedAtMs)),
    );
    items.push({
      kind: "cronOverdue",
      severity: "warning",
      icon: "clock",
      label: jobName,
      detail: t("attention.automationOverdue", { time }),
      meta: { status: t("attention.overdue"), time },
      action: { kind: "navigate", routeId: "cron" },
      signature,
    });
  }

  const monitored = listEffectiveModelAuthProviders(params.modelAuthStatus?.providers ?? []).filter(
    isMonitoredAuthProvider,
  );
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  for (const provider of expired) {
    // Auth is agent-scoped; one agent's dismissal must not hide another's warning.
    const signature = params.modelAuthAgentId
      ? `agent:${params.modelAuthAgentId}\n${provider.provider}`
      : provider.provider;
    const fact = `${provider.displayName}: ${provider.status}`;
    const scope =
      provider.profiles.find(
        (profile) => profile.status === "expired" || profile.status === "missing",
      )?.profileId ?? params.modelAuthAgentId?.trim();
    const time = formatTimeAgo(
      Math.max(0, params.now - (params.modelAuthStatus?.ts ?? params.now)),
      { suffix: false },
    );
    const detail = scope
      ? t("attention.modelAuthExpiredWithScope", { scope, time })
      : t("attention.modelAuthExpiredState", { time });
    const alertTitle = t("attention.modelAuthExpired", { providers: provider.displayName });
    items.push(
      explainedItem(
        {
          kind: "modelAuthExpired",
          severity: "error",
          icon: "plug",
          label: provider.displayName,
          detail,
          meta: { ...(scope ? { context: scope } : {}), status: t("attention.authExpired"), time },
          inlineAction: {
            label: t("attention.reconnect"),
            routeId: "model-providers",
          },
          signature,
        },
        {
          title: alertTitle,
          facts: [fact],
          question: boundedQuestion(
            t("attention.alerts.modelAuthExpiredQuestion", { facts: fact }),
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
