/** Lazy Control UI consent flow for reporting one authoritative failed update. */
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { UpdateReportResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";

registerUpdateActionsEnglish();

type ReadyUpdateReport = Extract<UpdateReportResult, { status: "ready" }>;
export type SubmittedUpdateReport = Exclude<UpdateReportResult, { status: "ready" }>;

// Covers 30s each for auth, creation, and uncertain-outcome lookup, plus delivery margin.
const UPDATE_REPORT_REQUEST_TIMEOUT_MS = 105_000;

export async function reportUpdateFailure(params: {
  attemptId: string;
  client: GatewayBrowserClient;
  isCurrent: () => boolean;
}): Promise<SubmittedUpdateReport | null> {
  const preview = await params.client.request<ReadyUpdateReport>(
    "update.report",
    { action: "preview", attemptId: params.attemptId },
    { timeoutMs: UPDATE_REPORT_REQUEST_TIMEOUT_MS },
  );
  if (preview.status !== "ready" || preview.attemptId !== params.attemptId || !params.isCurrent()) {
    return null;
  }
  const { showConfirmDialog } = await import("../components/confirm-dialog.ts");
  const confirmed = await showConfirmDialog({
    title: t("updates.report.title"),
    message: t("updates.report.message"),
    details: preview.body,
    confirmLabel: t("updates.report.submit"),
    cancelLabel: t("updates.report.cancel"),
  });
  if (!confirmed || !params.isCurrent()) {
    return null;
  }
  return await params.client.request<SubmittedUpdateReport>(
    "update.report",
    {
      action: "submit",
      attemptId: params.attemptId,
      previewDigest: preview.previewDigest,
    },
    { timeoutMs: UPDATE_REPORT_REQUEST_TIMEOUT_MS },
  );
}
