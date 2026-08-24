import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS, type ChatRunUiStatus } from "../run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "../tool-stream.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

export type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

export function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (
    status?.phase !== "interrupted" ||
    Date.now() - status.occurredAt >= CHAT_RUN_STATUS_TOAST_DURATION_MS
  ) {
    return nothing;
  }
  const interrupted = t("chat.composer.runInterrupted");
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--interrupted"
      aria-label=${t("chat.composer.runStatus", { status: interrupted })}
    >
      ${icons.messageCircleOff}<span class="agent-chat__run-status-label">${interrupted}</span>
    </span>
  `;
}

export function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "active" || status.phase === "retrying") {
    return html`
      <div
        class="compaction-indicator compaction-indicator--active"
        role="status"
        aria-live="polite"
      >
        ${icons.loader} ${t("chat.composer.compactingContext")}
      </div>
    `;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div
          class="compaction-indicator compaction-indicator--complete"
          role="status"
          aria-live="polite"
        >
          ${icons.check} ${t("chat.composer.contextCompacted")}
        </div>
      `;
    }
  }
  return nothing;
}

export function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    t("chat.composer.fallbackSelected", { model: status.selected }),
    t("chat.composer.fallbackCurrent", {
      model: phase === "cleared" ? status.selected : status.active,
    }),
    phase === "cleared" && status.previous
      ? t("chat.composer.fallbackPrevious", { model: status.previous })
      : null,
    status.reason ? t("chat.composer.fallbackReason", { reason: status.reason }) : null,
    status.attempts.length > 0
      ? t("chat.composer.fallbackAttempts", {
          attempts: status.attempts.slice(0, 3).join(" | "),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? t("chat.composer.fallbackCleared", { model: status.selected })
      : t("chat.composer.fallbackActive", { model: status.active });
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <openclaw-tooltip .content=${details}>
      <div class=${className} role="status" aria-live="polite" aria-label=${details}>
        ${icon} ${message}
      </div>
    </openclaw-tooltip>
  `;
}
