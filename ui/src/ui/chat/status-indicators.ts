import { html, nothing } from "lit";
import type { CompactionStatus, FallbackStatus } from "../app-tool-stream.ts";
import { icons } from "../icons.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS, type ChatRunUiStatus } from "./run-lifecycle.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

export type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

export function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase !== "in-progress") {
    const elapsed = Date.now() - status.occurredAt;
    if (elapsed >= CHAT_RUN_STATUS_TOAST_DURATION_MS) {
      return nothing;
    }
  }
  const label =
    status.phase === "in-progress"
      ? "In progress"
      : status.phase === "done"
        ? "Done"
        : "Interrupted";
  const icon =
    status.phase === "in-progress"
      ? icons.loader
      : status.phase === "done"
        ? icons.check
        : icons.stop;
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--${status.phase}"
      role="status"
      aria-live="polite"
      aria-label=${`Run status: ${label}`}
      title=${`Run status: ${label}`}
    >
      ${icon}<span class="agent-chat__run-status-label">${label}</span>
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
    <div class=${className} role="status" aria-live="polite" title=${details}>
      ${icon} ${message}
    </div>
  `;
}
