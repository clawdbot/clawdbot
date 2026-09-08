import type { NavigationRouteId } from "../app-navigation.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { t } from "../i18n/index.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { clampText } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { custodianAlertStore } from "../pages/custodian/custodian-alert-store.ts";
import type { ApplicationContext } from "./context.ts";
import type { UpdateFailureTriage, UpdateTriageAdmission } from "./update-overlay-helpers.ts";

registerSettingsEnglish();
registerUpdateActionsEnglish();

export function presentUpdateFailureTriage(
  context: ApplicationContext<NavigationRouteId>,
  failure: UpdateFailureTriage,
  admission: UpdateTriageAdmission,
): void {
  if (!admission.isCurrent()) {
    return;
  }
  if (!canCallGatewayMethod(context.gateway.snapshot, "openclaw.chat", "operator.admin")) {
    context.navigate("updates");
    return;
  }
  const attempt = failure.attempt;
  const record = failure.reconciledRecord;
  // Git updates may keep their version. Preserve commits and correlation before log text.
  const identity = (version: string | null, sha: string | null) =>
    [sha, version].filter(Boolean).join(" · ") || t("common.unknown");
  const details = [
    ...(record
      ? [
          `${t("updates.triage.observedRecord")}: ${record.id ?? t("common.unknown")} · ${record.timestampMs === null ? t("common.unknown") : new Date(record.timestampMs).toISOString()}`,
        ]
      : []),
    ...(attempt
      ? [
          `${t("updates.page.attemptedAt")}: ${new Date(attempt.timestampMs).toISOString()}`,
          `${t("updates.page.attemptReason")}: ${attempt.reason}`,
          `${t("updates.page.beforeUpdate")}: ${identity(attempt.beforeVersion, attempt.beforeSha)}`,
          `${t("updates.page.afterAttempt")}: ${identity(attempt.afterVersion, attempt.afterSha)}`,
          ...(attempt.failure ? [`${attempt.failure.step}: ${attempt.failure.detail}`] : []),
        ]
      : [failure.banner.text]),
  ];
  const title = t(
    failure.outcome === "unknown" ? "updates.triage.unknownTitle" : "updates.triage.failedTitle",
  );
  const facts = [...details, t("updates.triage.hostHint")].map((fact) =>
    clampText(formatUiExternalText(fact), 240),
  );
  custodianAlertStore.present(
    {
      id: failure.id,
      title,
      facts,
      question: clampText(
        t("updates.triage.question", { outcome: title, facts: facts.join("\n") }),
        2_400,
      ),
      action: {
        label: t("updates.reviewUpdate"),
        target: { kind: "navigate", routeId: "updates" },
      },
    },
    admission,
  );
  window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
}
