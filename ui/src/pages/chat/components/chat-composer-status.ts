import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS } from "../run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "../tool-stream.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

export type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

// Working and Done need no composer chrome: the thread's working spark,
// content arriving, and Stop reverting to Send already show them (screen
// readers get the composer's persistent sr-only run-status region).
// Interrupted keeps a visible toast: the transcript shows nothing when a run
// is killed, so silence would read as "finished".
export function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (status?.phase !== "interrupted") {
    return nothing;
  }
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= CHAT_RUN_STATUS_TOAST_DURATION_MS) {
    return nothing;
  }
  const interrupted = t("chat.composer.runInterrupted");
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--interrupted"
      aria-label=${t("chat.composer.runStatus", { status: interrupted })}
    >
      ${icons.stop}<span class="agent-chat__run-status-label">${interrupted}</span>
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
        ${icons.loader} Compacting context...
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
          ${icons.check} Context compacted
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
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
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
