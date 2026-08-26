import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { clampText, formatTimeAgo } from "../lib/format.ts";
import { isMonitoredAuthProvider, listEffectiveModelAuthProviders } from "../lib/model-auth.ts";
import type { CustodianAlert } from "./custodian-alert-contract.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
const ALERT_QUESTION_MAX_LENGTH = 1_000;
const SIDEBAR_ATTENTION_PRIORITY: Record<SidebarAttentionItem["kind"], number> = {
  modelAuthExpired: 0,
  cronFailed: 1,
  cronOverdue: 2,
};

export function compareSidebarAttentionEntries(
  left: SidebarAttentionItem,
  right: SidebarAttentionItem,
): number {
  return SIDEBAR_ATTENTION_PRIORITY[left.kind] - SIDEBAR_ATTENTION_PRIORITY[right.kind];
}

type SidebarAttentionContent = Omit<SidebarAttentionItem, "category" | "dismissal" | "type">;

export function buildSidebarAttentionEntries(params: {
  cronJobs: readonly CronJob[];
  cronOwnerByJobId?: ReadonlyMap<string, string>;
  modelAuthStatus: ModelAuthStatusResult | null;
  modelAuthAgentId?: string | null;
  now: number;
}): SidebarAttentionItem[] {
  const entries: SidebarAttentionItem[] = [];
  const cronJobName = (job: CronJob) => job.name?.trim() || job.id;
  const cronMeta = (job: CronJob, status: string, time: string) => {
    const context = params.cronOwnerByJobId?.get(job.id);
    return { ...(context ? { context } : {}), status, time };
  };
  const boundedQuestion = (question: string) => clampText(question, ALERT_QUESTION_MAX_LENGTH);
  const attentionEntry = (
    item: SidebarAttentionContent,
    category: SidebarAttentionItem["category"],
  ): SidebarAttentionItem => ({
    ...item,
    type: "attention",
    category,
    dismissal: { kind: item.kind, signature: item.signature },
  });
  const explainedItem = (
    item: Omit<SidebarAttentionContent, "action">,
    alert: Omit<CustodianAlert, "id">,
  ): SidebarAttentionContent => ({
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
    entries.push(
      attentionEntry(
        {
          kind: "cronFailed",
          severity: "error",
          icon: "clock",
          label: jobName,
          detail: t("attention.automationFailed", { time }),
          meta: cronMeta(job, t("attention.failed"), time),
          action: { kind: "navigate", routeId: "cron" },
          signature: job.id,
        },
        "automations",
      ),
    );
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
    entries.push(
      attentionEntry(
        {
          kind: "cronOverdue",
          severity: "warning",
          icon: "clock",
          label: jobName,
          detail: t("attention.automationOverdue", { time }),
          meta: cronMeta(job, t("attention.overdue"), time),
          action: { kind: "navigate", routeId: "cron" },
          signature,
        },
        "automations",
      ),
    );
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
    entries.push(
      attentionEntry(
        explainedItem(
          {
            kind: "modelAuthExpired",
            severity: "error",
            icon: "plug",
            label: provider.displayName,
            detail,
            meta: {
              ...(scope ? { context: scope } : {}),
              status: t("attention.authExpired"),
              time,
            },
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
        "system",
      ),
    );
  }
  return entries;
}
